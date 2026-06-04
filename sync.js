/**
 * sync.js — Stripe → HubSpot nightly donor sync + Google Sheets reporting
 *
 * Designed to run at 12:01 AM UTC via Railway Cron ("1 0 * * *").
 * Each run syncs all succeeded Stripe charges from the PREVIOUS calendar day
 * (yesterday 00:00:00 UTC → 23:59:59 UTC) and appends one summary row to a
 * Google Sheet:
 *
 *   Date | Daily Total ($) | Daily Donor Count | New Donors | Cumulative Total ($) | Cumulative Donors
 *
 * HOW CUMULATIVE DONORS IS CALCULATED:
 *   Stripe is the sole source of truth for donor identity. A donor is counted
 *   as "new" on the first calendar day their email appears in Stripe — regardless
 *   of whether they already exist in HubSpot. The running set of all-time seen
 *   emails is rebuilt from the full Stripe charge history on every run, so the
 *   cumulative count is always accurate and self-healing.
 *
 *   On a normal nightly run:
 *     1. All charges ever (up to yesterday) are fetched to build the historical
 *        seen-email set. This is cheap — Stripe paginates fast.
 *     2. Yesterday's donors are checked against that set. Emails not seen before
 *        yesterday count as new cumulative donors.
 *     3. cumulativeDonors = last sheet row's value + new donors from step 2.
 *
 * No .last_sync file is used — the time window is always deterministic
 * (yesterday), so every run is idempotent and self-contained.
 *
 * FIRST RUN / EMPTY SHEET (automatic):
 *   If the Google Sheet has no data rows when the script runs, it triggers a
 *   full historical backfill automatically:
 *     1. Fetches ALL succeeded charges from Stripe (entire account history).
 *     2. Groups them by calendar date (UTC).
 *     3. Upserts HubSpot contacts for every donor, day by day in order.
 *     4. Writes one sheet row per calendar date, building a complete history.
 *        Cumulative donors is computed by walking a running email set in
 *        chronological order — purely from Stripe data.
 *   After backfill completes, the sheet is fully up to date and subsequent
 *   nightly runs continue normally from yesterday onward.
 *
 * BACKFILL MODE (manual):
 *   node sync.js --date YYYY-MM-DD
 *   Syncs a specific past date instead of yesterday. Useful for re-running a
 *   missed night or patching a gap in the sheet.
 *
 * NOTE ON CALCULATED PROPERTIES:
 *   amount_left_to_donate, donation_limit_reached, and donation_compliance_status
 *   are HubSpot formula properties. They update automatically when
 *   totalindividualdonations changes. This script never writes to them.
 *
 * REQUIRED ENV VARS (.env):
 *   HUBSPOT_ACCESS_TOKEN
 *   STRIPE_SECRET_KEY
 *
 * OPTIONAL ENV VARS — omit to skip Google Sheets reporting:
 *   GOOGLE_SHEET_ID                 — ID from the sheet URL (the long string between /d/ and /edit)
 *   GOOGLE_SERVICE_ACCOUNT_JSON     — full contents of the service account key JSON file
 *
 * HOW TO RUN MANUALLY:
 *   node sync.js                        → syncs yesterday (or backfills if sheet is empty)
 *   node sync.js --date 2025-06-01      → syncs a specific date
 *
 * DEPENDENCIES:
 *   npm install dotenv axios stripe googleapis
 */

require('dotenv').config();
const axios  = require('axios');
const Stripe = require('stripe');
const { google } = require('googleapis');

// ─── Config ────────────────────────────────────────────────────────────────

const HUBSPOT_BASE = 'https://api.hubapi.com';
const DELAY_MS     = 150;   // stay under HubSpot's 100 req/10 s rate limit
const SHEET_TAB    = 'Sheet1'; // change if your tab has a different name

const hubspotHeaders = {
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Unix timestamp → HubSpot date (midnight UTC in ms) */
function toHubSpotDate(unixTs) {
  const dateOnly = new Date(unixTs * 1000).toISOString().split('T')[0];
  return new Date(`${dateOnly}T00:00:00.000Z`).getTime();
}

function splitName(fullName = '') {
  if (!fullName.trim()) return { firstname: '', lastname: '' };
  const parts = fullName.trim().split(/\s+/);
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

/**
 * Parse a YYYY-MM-DD string (UTC) and return { windowStart, windowEnd } as
 * Unix timestamps covering the full calendar day.
 */
function dayWindow(dateString) {
  const windowStart = Math.floor(new Date(`${dateString}T00:00:00.000Z`).getTime() / 1000);
  const windowEnd   = Math.floor(new Date(`${dateString}T23:59:59.999Z`).getTime() / 1000);
  return { windowStart, windowEnd };
}

/** Return yesterday's date as a YYYY-MM-DD string in UTC. */
function yesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * Parse --date YYYY-MM-DD from argv, or fall back to yesterday.
 * Throws if the value is present but not a valid date string.
 */
function resolveSyncDate() {
  const idx = process.argv.indexOf('--date');
  if (idx === -1) return yesterdayUTC();

  const val = process.argv[idx + 1];
  if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    throw new Error('--date requires a value in YYYY-MM-DD format (e.g. --date 2025-06-01)');
  }
  if (isNaN(new Date(`${val}T00:00:00.000Z`).getTime())) {
    throw new Error(`--date value "${val}" is not a valid calendar date`);
  }
  return val;
}

// ─── Stripe ────────────────────────────────────────────────────────────────

/**
 * Fetch all succeeded Stripe charges within [windowStart, windowEnd].
 * Automatically paginates through the full result set.
 */
async function fetchChargesForDay(stripe, windowStart, windowEnd) {
  const charges = [];
  let startingAfter;

  do {
    const params = {
      limit: 100,
      created: { gte: windowStart, lte: windowEnd },
    };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.charges.list(params);
    charges.push(...page.data.filter((c) => c.status === 'succeeded'));
    startingAfter = page.has_more ? page.data.at(-1).id : undefined;
  } while (startingAfter);

  return charges;
}

/**
 * Fetch every succeeded charge in the Stripe account (no date filter).
 * Used during full historical backfill, and also on normal nightly runs to
 * build the all-time seen-email set for accurate cumulative donor counting.
 */
async function fetchAllCharges(stripe, { silent = false } = {}) {
  const charges = [];
  let startingAfter;

  if (!silent) console.log('[stripe] Fetching all charges to build cumulative donor baseline...');

  do {
    const params = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.charges.list(params);
    charges.push(...page.data.filter((c) => c.status === 'succeeded'));
    startingAfter = page.has_more ? page.data.at(-1).id : undefined;

    if (!silent) process.stdout.write(`\r[stripe] ${charges.length} charges fetched so far...`);
  } while (startingAfter);

  if (!silent) process.stdout.write('\n');
  return charges;
}

function isValidEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email)) return false;
  const typoTLDs = ['.con', '.cmo', '.ocm', '.nte', '.rog', '.ogr', '.coj', '.cpm'];
  if (typoTLDs.some((typo) => email.endsWith(typo))) return false;
  return true;
}

/**
 * Extract a normalised email from a Stripe charge, or return null.
 */
function emailFromCharge(charge) {
  const raw = (
    charge.billing_details?.email ||
    charge.receipt_email ||
    ''
  ).toLowerCase().trim();

  if (!raw) return null;

  if (!isValidEmail(raw)) {
    console.warn(`[sync] Skipping malformed email on charge ${charge.id}: "${raw}"`);
    return null;
  }

  return raw;
}

/**
 * Group a set of charges by email.
 * Returns Map<email, { totalAmount, latestCreated, latestAmount, cardName }>
 */
function buildDonorMap(charges) {
  const donors = new Map();

  for (const charge of charges) {
    const email = emailFromCharge(charge);
    if (!email) continue;

    const amount   = charge.amount / 100;
    const created  = charge.created;
    const cardName = charge.billing_details?.name || '';

    if (donors.has(email)) {
      const d = donors.get(email);
      d.totalAmount = parseFloat((d.totalAmount + amount).toFixed(2));
      if (created > d.latestCreated) {
        d.latestCreated = created;
        d.latestAmount  = amount;
        d.cardName      = cardName || d.cardName;
      }
    } else {
      donors.set(email, {
        totalAmount: amount,
        latestCreated: created,
        latestAmount: amount,
        cardName,
      });
    }
  }

  return donors;
}

/**
 * Build a Set of all donor emails from charges that occurred strictly BEFORE
 * the given dateString (YYYY-MM-DD). Used to determine which of today's donors
 * are genuinely new (first-ever donation) vs. returning donors.
 *
 * @param {Array}  allCharges  — full Stripe charge history (pre-fetched)
 * @param {string} beforeDate  — YYYY-MM-DD; exclude charges on or after this date
 * @returns {Set<string>}
 */
function buildHistoricalEmailSet(allCharges, beforeDate) {
  const seen = new Set();
  for (const charge of allCharges) {
    const chargeDate = new Date(charge.created * 1000).toISOString().split('T')[0];
    if (chargeDate < beforeDate) {
      const email = emailFromCharge(charge);
      if (email) seen.add(email);
    }
  }
  return seen;
}

// ─── HubSpot ───────────────────────────────────────────────────────────────

async function findContactByEmail(email) {
  const res = await axios.post(
    `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
    {
      filterGroups: [{
        filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
      }],
      properties: ['email', 'totalindividualdonations'],
      limit: 1,
    },
    { headers: hubspotHeaders }
  );
  return res.data.results[0] || null;
}

/**
 * Create or update a HubSpot contact, always incrementing
 * totalindividualdonations by the provided amount.
 *
 * Returns { action: 'created'|'updated' }
 */
async function upsertContact(email, donor) {
  const { totalAmount, latestCreated, latestAmount, cardName } = donor;
  const { firstname, lastname } = splitName(cardName);
  const hubspotDate = toHubSpotDate(latestCreated);

  const existing = await findContactByEmail(email);
  await sleep(DELAY_MS);

  let newTotal;
  if (!existing) {
    newTotal = totalAmount;
  } else {
    const currentTotal = parseFloat(existing.properties.totalindividualdonations || 0);
    newTotal = parseFloat((currentTotal + totalAmount).toFixed(2));
  }

  const props = {
    totalindividualdonations: newTotal,
    last_donation_amount:     latestAmount,
    latest_donation_date:     hubspotDate,
    is_donor:                 true,
  };

  if (existing) {
    await axios.patch(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/${existing.id}`,
      { properties: props },
      { headers: hubspotHeaders }
    );
    return { action: 'updated' };
  } else {
    await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts`,
      { properties: { email, firstname, lastname, ...props } },
      { headers: hubspotHeaders }
    );
    return { action: 'created' };
  }
}

// ─── Google Sheets ─────────────────────────────────────────────────────────

async function getSheetsClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');

  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

/**
 * Check whether the sheet has any data rows (rows beyond the header).
 * Returns true if the sheet is empty (no data rows yet).
 */
async function isSheetEmpty(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!A:A`,
  });
  const rows = res.data.values || [];
  return rows.length <= 1;
}

/**
 * Read the last data row of columns E and F (cumulative totals).
 * Returns zeroes if the sheet has no data rows yet.
 */
async function getLastCumulativeTotals(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!E:F`,
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return { cumulativeTotal: 0, cumulativeDonors: 0 };

  const lastRow = rows[rows.length - 1];
  return {
    cumulativeTotal:  parseFloat(lastRow[0]) || 0,
    cumulativeDonors: parseInt(lastRow[1], 10) || 0,
  };
}

async function ensureSheetHeader(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!A1:F1`,
  });

  const firstRow = res.data.values?.[0];
  if (!firstRow || firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${SHEET_TAB}!A1:F1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'Date',
          'Daily Total ($)',
          'Daily Donor Count',
          'New Donors',
          'Cumulative Total ($)',
          'Cumulative Donors',
        ]],
      },
    });
    console.log('[sheets] Header row written.');
  }
}

/**
 * Append one summary row for the given date.
 *
 * @param {object} sheets
 * @param {object} summary
 * @param {string}  summary.date              — YYYY-MM-DD
 * @param {number}  summary.dailyTotal        — total $ donated that day
 * @param {number}  summary.dailyDonorCount   — unique donors that day (from Stripe)
 * @param {number}  summary.newDonorCount     — first-ever Stripe donors that day
 * @param {number}  [summary.overrideCumDonors] — if provided, use this value directly
 *                                               instead of incrementing from the sheet.
 *                                               Used during backfill where we track the
 *                                               running set ourselves.
 */
async function appendSheetRow(sheets, summary) {
  const { cumulativeTotal, cumulativeDonors } = await getLastCumulativeTotals(sheets);
  const newCumulativeTotal = parseFloat((cumulativeTotal + summary.dailyTotal).toFixed(2));

  // During backfill we pass the pre-computed cumulative donor count directly
  // so it's based purely on the Stripe email set, not on HubSpot create/update.
  const newCumulativeDonors =
    summary.overrideCumDonors !== undefined
      ? summary.overrideCumDonors
      : cumulativeDonors + summary.newDonorCount;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!A:F`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        summary.date,
        summary.dailyTotal.toFixed(2),
        summary.dailyDonorCount,
        summary.newDonorCount,
        newCumulativeTotal.toFixed(2),
        newCumulativeDonors,
      ]],
    },
  });

  console.log(
    `[sheets] Row appended → ${summary.date} | ` +
    `$${summary.dailyTotal.toFixed(2)} | ` +
    `${summary.dailyDonorCount} donors | ` +
    `${summary.newDonorCount} new | ` +
    `cumulative $${newCumulativeTotal.toFixed(2)} / ${newCumulativeDonors} donors`
  );
}

async function getSheetsClientOrNull() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    console.log('[sheets] GOOGLE_SHEET_ID not set — skipping sheet updates.');
    return null;
  }
  try {
    return await getSheetsClient();
  } catch (err) {
    console.warn(`[sheets] Could not authenticate — skipping sheet updates. (${err.message})`);
    return null;
  }
}

// ─── Full historical backfill ───────────────────────────────────────────────

/**
 * Triggered automatically when the sheet is empty on first run.
 *
 * Fetches ALL Stripe charges, groups them by calendar date, and processes
 * each day in chronological order — upserting HubSpot contacts and writing
 * one sheet row per day.
 *
 * Cumulative donors is computed by walking a running Set of all-time seen
 * emails in date order, using Stripe as the sole source of truth. HubSpot's
 * created/updated distinction is intentionally ignored for this count.
 */
async function runFullBackfill(stripe, sheets) {
  console.log('\n[backfill] Sheet is empty — running full historical backfill.');
  console.log('[backfill] This will populate HubSpot and the sheet with all-time data.\n');

  const allCharges = await fetchAllCharges(stripe);

  if (allCharges.length === 0) {
    console.log('[backfill] No charges found in Stripe — nothing to backfill.');
    return;
  }

  // Partition charges by calendar date.
  const chargesByDate = new Map();
  for (const charge of allCharges) {
    const dateStr = new Date(charge.created * 1000).toISOString().split('T')[0];
    if (!chargesByDate.has(dateStr)) chargesByDate.set(dateStr, []);
    chargesByDate.get(dateStr).push(charge);
  }

  const sortedDates   = [...chargesByDate.keys()].sort();
  const yesterday     = yesterdayUTC();
  const datesToProcess = sortedDates.filter((d) => d <= yesterday);

  console.log(`[backfill] ${datesToProcess.length} calendar day(s) to process ` +
              `(${datesToProcess[0]} → ${datesToProcess.at(-1)}).\n`);

  // Running set of all emails ever seen — this is the source of truth for
  // cumulative donor counts, built purely from Stripe data.
  const allTimeSeenEmails = new Set();

  let totalCreated = 0, totalUpdated = 0, totalFailed = 0;

  for (let i = 0; i < datesToProcess.length; i++) {
    const dateStr    = datesToProcess[i];
    const dayCharges = chargesByDate.get(dateStr);
    const donorMap   = buildDonorMap(dayCharges);

    // Determine which emails are new to the all-time set on this day.
    const newEmailsToday = [...donorMap.keys()].filter(e => !allTimeSeenEmails.has(e));
    newEmailsToday.forEach(e => allTimeSeenEmails.add(e));

    // Cumulative donor count at end of this day = size of the all-time set.
    const cumulativeDonorsToday = allTimeSeenEmails.size;

    console.log(`[backfill] [${i + 1}/${datesToProcess.length}] ${dateStr} — ` +
                `${dayCharges.length} charge(s), ${donorMap.size} donor(s), ` +
                `${newEmailsToday.length} new (cumulative: ${cumulativeDonorsToday})`);

    if (donorMap.size === 0) {
      await appendSheetRow(sheets, {
        date: dateStr,
        dailyTotal: 0,
        dailyDonorCount: 0,
        newDonorCount: 0,
        overrideCumDonors: cumulativeDonorsToday,
      });
      continue;
    }

    let dayCreated = 0, dayUpdated = 0, dayFailed = 0;
    let dailyTotal = 0;

    for (const [email, donor] of donorMap) {
      try {
        const { action } = await upsertContact(email, donor);
        dailyTotal = parseFloat((dailyTotal + donor.totalAmount).toFixed(2));
        if (action === 'created') { dayCreated++; } else { dayUpdated++; }
      } catch (err) {
        const msg = err.response?.data?.message || err.message;
        console.error(`  ✗ FAILED   ${email} — ${msg}`);
        dayFailed++;
      }
      await sleep(DELAY_MS);
    }

    totalCreated += dayCreated;
    totalUpdated += dayUpdated;
    totalFailed  += dayFailed;

    if (dayFailed > 0) {
      console.warn(`  [backfill] ${dayFailed} failure(s) on ${dateStr} — sheet row skipped for this date.`);
    } else {
      await appendSheetRow(sheets, {
        date:              dateStr,
        dailyTotal,
        dailyDonorCount:   donorMap.size,
        newDonorCount:     newEmailsToday.length,  // Stripe-based, not HubSpot-based
        overrideCumDonors: cumulativeDonorsToday,  // Stripe-based running total
      });
    }
  }

  console.log('\n────────────────────────────────────────');
  console.log('Backfill complete.');
  console.log(`  Days processed  : ${datesToProcess.length}`);
  console.log(`  Contacts created: ${totalCreated}`);
  console.log(`  Contacts updated: ${totalUpdated}`);
  console.log(`  Failures        : ${totalFailed}`);
  console.log('────────────────────────────────────────\n');

  if (totalFailed > 0) {
    console.warn('[backfill] Some days had failures. Re-run with --date YYYY-MM-DD to patch gaps.');
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function run() {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) throw new Error('HUBSPOT_ACCESS_TOKEN not set in .env');
  if (!process.env.STRIPE_SECRET_KEY)    throw new Error('STRIPE_SECRET_KEY not set in .env');

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sheets = await getSheetsClientOrNull();

  // ── Full historical backfill (only when sheet is empty) ──────────────────
  if (sheets && await isSheetEmpty(sheets)) {
    await ensureSheetHeader(sheets);
    await runFullBackfill(stripe, sheets);
    return;
  }

  // ── Normal nightly run (or manual --date backfill) ───────────────────────
  const syncDate = resolveSyncDate();
  const { windowStart, windowEnd } = dayWindow(syncDate);

  console.log(`[sync] Syncing charges for ${syncDate} ` +
              `(${new Date(windowStart * 1000).toISOString()} → ${new Date(windowEnd * 1000).toISOString()})`);

  // Fetch today's charges for HubSpot sync + daily stats.
  const charges = await fetchChargesForDay(stripe, windowStart, windowEnd);
  console.log(`[sync] ${charges.length} succeeded charge(s) fetched from Stripe`);

  const donorMap = buildDonorMap(charges);
  console.log(`[sync] ${donorMap.size} unique donor(s) to process`);

  if (donorMap.size === 0) {
    console.log('[sync] No donations that day — writing zero row to sheet.');
    if (sheets) {
      await ensureSheetHeader(sheets);
      // Zero-donation day: new donors = 0, cumulative donors unchanged.
      await appendSheetRow(sheets, {
        date: syncDate,
        dailyTotal: 0,
        dailyDonorCount: 0,
        newDonorCount: 0,
      });
    }
    return { created: 0, updated: 0, failed: 0 };
  }

  // Build the set of all emails that appeared in Stripe BEFORE today.
  // Any email in today's donorMap that isn't in this set is a new cumulative donor.
  let historicalEmailSet = new Set();
  if (sheets) {
    const allCharges = await fetchAllCharges(stripe, { silent: true });
    historicalEmailSet = buildHistoricalEmailSet(allCharges, syncDate);
    console.log(`[sync] Historical baseline: ${historicalEmailSet.size} unique donors before ${syncDate}`);
  }

  let created = 0, updated = 0, failed = 0;
  let dailyTotal = 0;

  for (const [email, donor] of donorMap) {
    try {
      const { action } = await upsertContact(email, donor);
      dailyTotal = parseFloat((dailyTotal + donor.totalAmount).toFixed(2));

      if (action === 'created') {
        console.log(`  ✓ CREATED  ${email} — $${donor.totalAmount}`);
        created++;
      } else {
        console.log(`  ✓ UPDATED  ${email} — +$${donor.totalAmount}`);
        updated++;
      }
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error(`  ✗ FAILED   ${email} — ${msg}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  // Count donors whose email has never appeared in Stripe before today.
  const newDonorCount = [...donorMap.keys()].filter(e => !historicalEmailSet.has(e)).length;

  console.log(`\n────────────────────────────────────────`);
  console.log(`Sync complete for ${syncDate}.`);
  console.log(`  Daily donors : ${donorMap.size} (${newDonorCount} first-time)`);
  console.log(`  HubSpot created: ${created}`);
  console.log(`  HubSpot updated: ${updated}`);
  console.log(`  Failed         : ${failed}`);
  console.log(`────────────────────────────────────────\n`);

  if (failed > 0) {
    console.warn(`[sync] ${failed} failure(s) — sheet row NOT written. Re-run with --date ${syncDate} to retry.`);
  } else if (sheets) {
    await ensureSheetHeader(sheets);
    await appendSheetRow(sheets, {
      date:            syncDate,
      dailyTotal,
      dailyDonorCount: donorMap.size,
      newDonorCount,             // Stripe-based: emails not seen before today
      // No overrideCumDonors — appendSheetRow will add newDonorCount to the
      // last row's cumulative value, which is correct for a normal nightly run.
    });
  }

  return { created, updated, failed };
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => {
    console.error('[sync] Fatal:', err.response?.data || err.message);
    process.exit(1);
  });
}