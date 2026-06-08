/**
 * sync.js — Stripe → HubSpot nightly donor sync + Google Sheets reporting
 *
 * Designed to run at 12:01 AM UTC via Railway Cron ("1 0 * * *").
 * Each run syncs all succeeded Stripe charges from the PREVIOUS calendar day
 * (yesterday 00:00:00 UTC → 23:59:59 UTC), processes any refunds issued that
 * day, and appends one summary row to a Google Sheet:
 *
 *   Date | Daily Total ($) | Daily Donor Count | New Donors |
 *   Daily Refunds ($) | Daily Refund Count | Net Daily ($) |
 *   Cumulative Total ($) | Cumulative Donors
 *
 * HOW REFUNDS ARE HANDLED:
 *   Refunds are tracked by the date the refund was *issued*, not the date of
 *   the original charge. Each nightly run fetches all Stripe refunds created
 *   on the sync day and:
 *     1. Subtracts the refunded amount from the donor's HubSpot
 *        totalindividualdonations property.
 *     2. If the new total would reach $0 (full refund), also sets is_donor
 *        to false on the contact.
 *     3. Appends one row per refund to the Refunds sheet tab.
 *     4. Writes the day's refund total and count into the Summary tab.
 *        Cumulative Total tracks net dollars (charges minus refunds).
 *
 *   Cumulative donor count is NOT decremented by refunds — once someone has
 *   made a successful charge, they remain in the historical donor count even
 *   if later refunded. This keeps historical summary rows stable.
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
 *     1. Fetches ALL succeeded charges and ALL refunds from Stripe.
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

const HUBSPOT_BASE      = 'https://api.hubapi.com';
const DELAY_MS          = 150;   // stay under HubSpot's 100 req/10 s rate limit
const SHEET_TAB         = 'Summary';
const DONORS_SHEET_TAB  = 'Donors';
const REFUNDS_SHEET_TAB = 'Refunds';

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

// ─── Stripe — Charges ──────────────────────────────────────────────────────

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
 * Returns Map<email, { totalAmount, latestCreated, latestAmount, cardName, id }>
 *
 * The `id` field holds the Stripe charge ID of the most recent charge for
 * that donor on the day, and is written to the Donors sheet for traceability.
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
        d.id            = charge.id;
      }
    } else {
      donors.set(email, {
        totalAmount: amount,
        latestCreated: created,
        latestAmount: amount,
        cardName,
        id: charge.id,
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

// ─── Stripe — Refunds ──────────────────────────────────────────────────────

/**
 * Fetch all succeeded Stripe refunds created within [windowStart, windowEnd].
 * Each refund object includes r.charge (the original charge ID) and r.amount
 * (in cents). Automatically paginates.
 */
async function fetchRefundsForDay(stripe, windowStart, windowEnd) {
  const refunds = [];
  let startingAfter;

  do {
    const params = {
      limit: 100,
      created: { gte: windowStart, lte: windowEnd },
    };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.refunds.list(params);
    refunds.push(...page.data.filter((r) => r.status === 'succeeded'));
    startingAfter = page.has_more ? page.data.at(-1).id : undefined;
  } while (startingAfter);

  return refunds;
}

/**
 * Fetch every refund in the Stripe account (no date filter).
 * Used during full historical backfill to apply all-time refunds by date.
 */
async function fetchAllRefunds(stripe, { silent = false } = {}) {
  const refunds = [];
  let startingAfter;

  if (!silent) console.log('[stripe] Fetching all refunds for backfill...');

  do {
    const params = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.refunds.list(params);
    refunds.push(...page.data.filter((r) => r.status === 'succeeded'));
    startingAfter = page.has_more ? page.data.at(-1).id : undefined;

    if (!silent) process.stdout.write(`\r[stripe] ${refunds.length} refunds fetched so far...`);
  } while (startingAfter);

  if (!silent) process.stdout.write('\n');
  return refunds;
}

/**
 * Given a list of Stripe refunds, resolve each one to a donor email by
 * looking up the original charge. Returns an array of enriched refund objects:
 *   { refundId, chargeId, email, amount, created }
 *
 * We batch-resolve charge IDs we haven't already seen to minimise API calls.
 * A local chargeCache (Map<chargeId, charge>) is maintained across calls
 * during a single run to avoid re-fetching the same charge twice.
 *
 * @param {Stripe}   stripe
 * @param {Array}    refunds     — raw Stripe refund objects
 * @param {Map}      chargeCache — shared cache of already-fetched charges
 * @param {boolean}  silent
 */
async function resolveRefundEmails(stripe, refunds, chargeCache, { silent = false } = {}) {
  const resolved = [];

  for (const refund of refunds) {
    const chargeId = refund.charge;

    if (!chargeCache.has(chargeId)) {
      try {
        const charge = await stripe.charges.retrieve(chargeId);
        chargeCache.set(chargeId, charge);
        await sleep(DELAY_MS);
      } catch (err) {
        if (!silent) console.warn(`[refund] Could not retrieve charge ${chargeId}: ${err.message}`);
        continue;
      }
    }

    const charge = chargeCache.get(chargeId);
    const email  = emailFromCharge(charge);
    if (!email) {
      if (!silent) console.warn(`[refund] No valid email on charge ${chargeId} — skipping refund ${refund.id}`);
      continue;
    }

    resolved.push({
      refundId:  refund.id,
      chargeId,
      email,
      amount:    refund.amount / 100,   // convert cents → dollars
      created:   refund.created,
    });
  }

  return resolved;
}

// ─── HubSpot ───────────────────────────────────────────────────────────────

async function findContactByEmail(email) {
  const res = await axios.post(
    `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
    {
      filterGroups: [{
        filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
      }],
      properties: ['email', 'totalindividualdonations', 'is_donor'],
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

/**
 * Subtract a refunded amount from a contact's totalindividualdonations.
 *
 * - Partial refund: decrements the total, leaves is_donor true.
 * - Full refund (new total reaches $0): sets is_donor to false as well.
 * - Contact not found in HubSpot: logs a warning and skips gracefully —
 *   this can happen if the original charge pre-dates the first sync run.
 *
 * Returns { action: 'partially_refunded'|'fully_refunded'|'not_found', newTotal }
 */
async function applyRefundToContact(email, refundAmount) {
  const existing = await findContactByEmail(email);
  await sleep(DELAY_MS);

  if (!existing) {
    console.warn(`[refund] No HubSpot contact found for ${email} — skipping HubSpot update.`);
    return { action: 'not_found', newTotal: null };
  }

  const currentTotal = parseFloat(existing.properties.totalindividualdonations || 0);
  const newTotal     = parseFloat(Math.max(0, currentTotal - refundAmount).toFixed(2));
  const isFullRefund = newTotal === 0;

  const props = { totalindividualdonations: newTotal };
  if (isFullRefund) props.is_donor = false;

  await axios.patch(
    `${HUBSPOT_BASE}/crm/v3/objects/contacts/${existing.id}`,
    { properties: props },
    { headers: hubspotHeaders }
  );

  return {
    action:   isFullRefund ? 'fully_refunded' : 'partially_refunded',
    newTotal,
  };
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
 * Check whether the Summary sheet has any data rows (rows beyond the header).
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
 * Read the last data row of the cumulative columns (H and I).
 * Returns zeroes if the sheet has no data rows yet.
 *
 * Summary tab column layout (1-indexed):
 *   A: Date
 *   B: Daily Total ($)
 *   C: Daily Donor Count
 *   D: New Donors
 *   E: Daily Refunds ($)
 *   F: Daily Refund Count
 *   G: Net Daily ($)
 *   H: Cumulative Total ($)
 *   I: Cumulative Donors
 */
async function getLastCumulativeTotals(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!A:I`,
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return { cumulativeTotal: 0, cumulativeDonors: 0 };

  const lastRow = rows[rows.length - 1];

  // Strip currency symbols, commas, and whitespace before parsing
  const cleanNumber = (val) => parseFloat(String(val || '').replace(/[$,\s]/g, '')) || 0;

  return {
    cumulativeTotal:  cleanNumber(lastRow[7]),
    cumulativeDonors: parseInt(String(lastRow[8] || '').replace(/[$,\s]/g, ''), 10) || 0,
  };
}

async function ensureSummaryHeader(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!A1:I1`,
  });

  const firstRow = res.data.values?.[0];
  if (!firstRow || firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${SHEET_TAB}!A1:I1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'Date',
          'Daily Total ($)',
          'Daily Donor Count',
          'New Donors',
          'Daily Refunds ($)',
          'Daily Refund Count',
          'Net Daily ($)',
          'Cumulative Total ($)',
          'Cumulative Donors',
        ]],
      },
    });
    console.log('[sheets] Summary header row written.');
  }
}

async function ensureRefundsHeader(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${REFUNDS_SHEET_TAB}!A1:G1`,
  });

  const firstRow = res.data.values?.[0];
  if (!firstRow || firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${REFUNDS_SHEET_TAB}!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'Date',
          'Email',
          'Refund Amount ($)',
          'Original Charge ID',
          'Refund ID',
          'Type',
          'HubSpot Status',
        ]],
      },
    });
    console.log('[sheets] Refunds header row written.');
  }
}

async function ensureSheetHeaders(sheets) {
  await ensureSummaryHeader(sheets);
  await ensureRefundsHeader(sheets);
}

/**
 * Append one summary row for the given date.
 *
 * @param {object} sheets
 * @param {object} summary
 * @param {string}  summary.date               — YYYY-MM-DD
 * @param {number}  summary.dailyTotal         — gross $ donated that day (pre-refund)
 * @param {number}  summary.dailyDonorCount    — unique donors that day (from Stripe)
 * @param {number}  summary.newDonorCount      — first-ever Stripe donors that day
 * @param {number}  summary.dailyRefundTotal   — total $ refunded that day
 * @param {number}  summary.dailyRefundCount   — number of refunds that day
 * @param {number}  [summary.overrideCumDonors] — if provided, use this value directly
 *                                               instead of incrementing from the sheet.
 *                                               Used during backfill where we track the
 *                                               running set ourselves.
 */
async function appendSheetRow(sheets, summary) {
  const { cumulativeTotal, cumulativeDonors } = await getLastCumulativeTotals(sheets);

  const dailyRefundTotal  = summary.dailyRefundTotal  || 0;
  const dailyRefundCount  = summary.dailyRefundCount  || 0;
  const netDaily          = parseFloat((summary.dailyTotal - dailyRefundTotal).toFixed(2));
  const newCumulativeTotal = parseFloat((cumulativeTotal + netDaily).toFixed(2));

  // During backfill, pass the pre-computed cumulative donor count directly.
  const newCumulativeDonors =
    summary.overrideCumDonors !== undefined
      ? summary.overrideCumDonors
      : cumulativeDonors + summary.newDonorCount;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!A:I`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        summary.date,
        summary.dailyTotal.toFixed(2),
        summary.dailyDonorCount,
        summary.newDonorCount,
        dailyRefundTotal.toFixed(2),
        dailyRefundCount,
        netDaily.toFixed(2),
        newCumulativeTotal.toFixed(2),
        newCumulativeDonors,
      ]],
    },
  });

  console.log(
    `[sheets] Row appended → ${summary.date} | ` +
    `gross $${summary.dailyTotal.toFixed(2)} | ` +
    `refunds -$${dailyRefundTotal.toFixed(2)} (${dailyRefundCount}) | ` +
    `net $${netDaily.toFixed(2)} | ` +
    `${summary.dailyDonorCount} donors | ${summary.newDonorCount} new | ` +
    `cumulative $${newCumulativeTotal.toFixed(2)} / ${newCumulativeDonors} donors`
  );
}

/**
 * Append one row per donor to the Donors tab.
 * Columns: Date | Email | First Name | Last Name | Amount ($) | Stripe Charge ID
 */
async function appendDonorRows(sheets, donorRows) {
  if (donorRows.length === 0) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range:         `${DONORS_SHEET_TAB}!A:F`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: donorRows },
  });

  console.log(`[sheets] ${donorRows.length} donor row(s) appended to ${DONORS_SHEET_TAB}`);
}

/**
 * Append one row per refund to the Refunds tab.
 * Columns: Date | Email | Refund Amount ($) | Original Charge ID | Refund ID | Type | HubSpot Status
 */
async function appendRefundRows(sheets, refundRows) {
  if (refundRows.length === 0) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range:         `${REFUNDS_SHEET_TAB}!A:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: refundRows },
  });

  console.log(`[sheets] ${refundRows.length} refund row(s) appended to ${REFUNDS_SHEET_TAB}`);
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

// ─── Process refunds for a given day ───────────────────────────────────────

/**
 * Fetches all refunds for the given day, resolves their emails, applies them
 * to HubSpot, and returns summary data + sheet rows.
 *
 * @param {Stripe}  stripe
 * @param {number}  windowStart — Unix ts
 * @param {number}  windowEnd   — Unix ts
 * @param {string}  dateStr     — YYYY-MM-DD (used for sheet rows)
 * @param {Map}     chargeCache — shared charge lookup cache
 * @returns {{ dailyRefundTotal, dailyRefundCount, refundRows, refundFailed }}
 */
async function processDayRefunds(stripe, windowStart, windowEnd, dateStr, chargeCache) {
  const rawRefunds = await fetchRefundsForDay(stripe, windowStart, windowEnd);
  console.log(`[refunds] ${rawRefunds.length} refund(s) on ${dateStr}`);

  if (rawRefunds.length === 0) {
    return { dailyRefundTotal: 0, dailyRefundCount: 0, refundRows: [], refundFailed: 0 };
  }

  const resolved = await resolveRefundEmails(stripe, rawRefunds, chargeCache);

  let dailyRefundTotal = 0;
  let refundFailed     = 0;
  const refundRows     = [];

  for (const r of resolved) {
    try {
      const { action } = await applyRefundToContact(r.email, r.amount);
      dailyRefundTotal = parseFloat((dailyRefundTotal + r.amount).toFixed(2));

      const typeLabel = action === 'fully_refunded' ? 'full' : 'partial';
      console.log(`  ↩ REFUND   ${r.email} — -$${r.amount} (${action})`);

      refundRows.push([
        dateStr,
        r.email,
        r.amount.toFixed(2),
        r.chargeId,
        r.refundId,
        typeLabel,
        action,
      ]);
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error(`  ✗ REFUND FAILED   ${r.email} — ${msg}`);
      refundFailed++;
    }

    await sleep(DELAY_MS);
  }

  return {
    dailyRefundTotal,
    dailyRefundCount: resolved.length,
    refundRows,
    refundFailed,
  };
}

// ─── Full historical backfill ───────────────────────────────────────────────

/**
 * Triggered automatically when the sheet is empty on first run.
 *
 * Fetches ALL Stripe charges and refunds, groups them by calendar date, and
 * processes each day in chronological order — upserting HubSpot contacts,
 * applying refunds, and writing one sheet row per day.
 *
 * Cumulative donors is computed by walking a running Set of all-time seen
 * emails in date order, using Stripe as the sole source of truth. HubSpot's
 * created/updated distinction is intentionally ignored for this count.
 * Cumulative Total tracks net dollars (charges minus refunds).
 */
async function runFullBackfill(stripe, sheets) {
  console.log('\n[backfill] Sheet is empty — running full historical backfill.');
  console.log('[backfill] This will populate HubSpot and the sheet with all-time data.\n');

  const [allCharges, allRefunds] = await Promise.all([
    fetchAllCharges(stripe),
    fetchAllRefunds(stripe),
  ]);

  if (allCharges.length === 0) {
    console.log('[backfill] No charges found in Stripe — nothing to backfill.');
    return;
  }

  // Build a charge cache from allCharges so resolveRefundEmails can look up
  // emails without additional API calls for charges we already have.
  const chargeCache = new Map(allCharges.map((c) => [c.id, c]));

  // Partition charges by calendar date.
  const chargesByDate = new Map();
  for (const charge of allCharges) {
    const dateStr = new Date(charge.created * 1000).toISOString().split('T')[0];
    if (!chargesByDate.has(dateStr)) chargesByDate.set(dateStr, []);
    chargesByDate.get(dateStr).push(charge);
  }

  // Partition refunds by calendar date (date the refund was issued).
  const refundsByDate = new Map();
  for (const refund of allRefunds) {
    const dateStr = new Date(refund.created * 1000).toISOString().split('T')[0];
    if (!refundsByDate.has(dateStr)) refundsByDate.set(dateStr, []);
    refundsByDate.get(dateStr).push(refund);
  }

  // Union of all dates that have either charges or refunds.
  const allDates    = new Set([...chargesByDate.keys(), ...refundsByDate.keys()]);
  const yesterday   = yesterdayUTC();
  const sortedDates = [...allDates].sort().filter((d) => d <= yesterday);

  console.log(`[backfill] ${sortedDates.length} calendar day(s) to process ` +
              `(${sortedDates[0]} → ${sortedDates.at(-1)}).\n`);

  // Running set of all emails ever seen — source of truth for cumulative donor counts.
  const allTimeSeenEmails = new Set();

  let totalCreated = 0, totalUpdated = 0, totalFailed = 0;
  let totalRefundFailed = 0;

  for (let i = 0; i < sortedDates.length; i++) {
    const dateStr    = sortedDates[i];
    const dayCharges = chargesByDate.get(dateStr) || [];
    const dayRefunds = refundsByDate.get(dateStr) || [];
    const donorMap   = buildDonorMap(dayCharges);

    // Determine which emails are new to the all-time set on this day.
    const newEmailsToday = [...donorMap.keys()].filter(e => !allTimeSeenEmails.has(e));
    newEmailsToday.forEach(e => allTimeSeenEmails.add(e));

    const cumulativeDonorsToday = allTimeSeenEmails.size;

    console.log(`[backfill] [${i + 1}/${sortedDates.length}] ${dateStr} — ` +
                `${dayCharges.length} charge(s), ${donorMap.size} donor(s), ` +
                `${newEmailsToday.length} new (cumulative: ${cumulativeDonorsToday}), ` +
                `${dayRefunds.length} refund(s)`);

    let dayCreated = 0, dayUpdated = 0, dayFailed = 0;
    let dailyTotal = 0;
    const donorRows = [];

    // ── Process charges ──────────────────────────────────────────────────
    for (const [email, donor] of donorMap) {
      try {
        const { action } = await upsertContact(email, donor);
        dailyTotal = parseFloat((dailyTotal + donor.totalAmount).toFixed(2));
        if (action === 'created') { dayCreated++; } else { dayUpdated++; }

        const { firstname, lastname } = splitName(donor.cardName);
        donorRows.push([
          dateStr,
          email,
          firstname,
          lastname,
          donor.totalAmount.toFixed(2),
          donor.id,
        ]);
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

    // ── Process refunds ──────────────────────────────────────────────────
    let dailyRefundTotal = 0;
    let dailyRefundCount = 0;
    const refundRows     = [];
    let dayRefundFailed  = 0;

    if (dayRefunds.length > 0) {
      const resolved = await resolveRefundEmails(stripe, dayRefunds, chargeCache, { silent: true });

      for (const r of resolved) {
        try {
          const { action } = await applyRefundToContact(r.email, r.amount);
          dailyRefundTotal = parseFloat((dailyRefundTotal + r.amount).toFixed(2));
          dailyRefundCount++;

          const typeLabel = action === 'fully_refunded' ? 'full' : 'partial';
          refundRows.push([
            dateStr,
            r.email,
            r.amount.toFixed(2),
            r.chargeId,
            r.refundId,
            typeLabel,
            action,
          ]);
        } catch (err) {
          const msg = err.response?.data?.message || err.message;
          console.error(`  ✗ REFUND FAILED   ${r.email} — ${msg}`);
          dayRefundFailed++;
        }
        await sleep(DELAY_MS);
      }

      totalRefundFailed += dayRefundFailed;
    }

    // ── Write sheet rows (skip if charge failures occurred) ──────────────
    if (dayFailed > 0) {
      console.warn(`  [backfill] ${dayFailed} charge failure(s) on ${dateStr} — Summary row skipped.`);
    } else {
      await appendSheetRow(sheets, {
        date:              dateStr,
        dailyTotal,
        dailyDonorCount:   donorMap.size,
        newDonorCount:     newEmailsToday.length,
        dailyRefundTotal,
        dailyRefundCount,
        overrideCumDonors: cumulativeDonorsToday,
      });

      if (donorRows.length > 0)  await appendDonorRows(sheets, donorRows);
      if (refundRows.length > 0) await appendRefundRows(sheets, refundRows);
    }
  }

  console.log('\n────────────────────────────────────────');
  console.log('Backfill complete.');
  console.log(`  Days processed        : ${sortedDates.length}`);
  console.log(`  Contacts created      : ${totalCreated}`);
  console.log(`  Contacts updated      : ${totalUpdated}`);
  console.log(`  Charge failures       : ${totalFailed}`);
  console.log(`  Refund failures       : ${totalRefundFailed}`);
  console.log('────────────────────────────────────────\n');

  if (totalFailed > 0 || totalRefundFailed > 0) {
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
    await ensureSheetHeaders(sheets);
    await runFullBackfill(stripe, sheets);
    return;
  }

  // ── Normal nightly run (or manual --date backfill) ───────────────────────
  const syncDate = resolveSyncDate();
  const { windowStart, windowEnd } = dayWindow(syncDate);

  console.log(`[sync] Syncing charges for ${syncDate} ` +
              `(${new Date(windowStart * 1000).toISOString()} → ${new Date(windowEnd * 1000).toISOString()})`);

  const charges = await fetchChargesForDay(stripe, windowStart, windowEnd);
  console.log(`[sync] ${charges.length} succeeded charge(s) fetched from Stripe`);

  const donorMap = buildDonorMap(charges);
  console.log(`[sync] ${donorMap.size} unique donor(s) to process`);

  // Charge cache used by both refund resolution and any future charge lookups.
  // Pre-populate with today's fetched charges to avoid redundant API calls.
  const chargeCache = new Map(charges.map((c) => [c.id, c]));

  // ── Build historical email set for new-donor detection ──────────────────
  let historicalEmailSet = new Set();
  if (sheets) {
    const allCharges = await fetchAllCharges(stripe, { silent: true });
    historicalEmailSet = buildHistoricalEmailSet(allCharges, syncDate);
    // Also seed the charge cache with historical charges for refund resolution.
    for (const c of allCharges) {
      if (!chargeCache.has(c.id)) chargeCache.set(c.id, c);
    }
    console.log(`[sync] Historical baseline: ${historicalEmailSet.size} unique donors before ${syncDate}`);
  }

  // ── Process charges ──────────────────────────────────────────────────────
  let created = 0, updated = 0, failed = 0;
  let dailyTotal = 0;
  const donorRows = [];

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

      const { firstname, lastname } = splitName(donor.cardName);
      donorRows.push([
        syncDate,
        email,
        firstname,
        lastname,
        donor.totalAmount.toFixed(2),
        donor.id,
      ]);

    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error(`  ✗ FAILED   ${email} — ${msg}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  const newDonorCount = [...donorMap.keys()].filter(e => !historicalEmailSet.has(e)).length;

  // ── Process refunds ──────────────────────────────────────────────────────
  const { dailyRefundTotal, dailyRefundCount, refundRows, refundFailed } =
    await processDayRefunds(stripe, windowStart, windowEnd, syncDate, chargeCache);

  // ── Summary log ──────────────────────────────────────────────────────────
  console.log(`\n────────────────────────────────────────`);
  console.log(`Sync complete for ${syncDate}.`);
  console.log(`  Daily donors   : ${donorMap.size} (${newDonorCount} first-time)`);
  console.log(`  HubSpot created: ${created}`);
  console.log(`  HubSpot updated: ${updated}`);
  console.log(`  Charge failures: ${failed}`);
  console.log(`  Refunds        : ${dailyRefundCount} (-$${dailyRefundTotal.toFixed(2)})`);
  console.log(`  Refund failures: ${refundFailed}`);
  console.log(`────────────────────────────────────────\n`);

  // ── Write to sheets (only if no charge failures) ─────────────────────────
  if (failed > 0) {
    console.warn(`[sync] ${failed} charge failure(s) — sheet rows NOT written. Re-run with --date ${syncDate} to retry.`);
  } else if (sheets) {
    await ensureSheetHeaders(sheets);

    await appendSheetRow(sheets, {
      date:            syncDate,
      dailyTotal,
      dailyDonorCount: donorMap.size,
      newDonorCount,
      dailyRefundTotal,
      dailyRefundCount,
    });

    if (donorRows.length > 0)  await appendDonorRows(sheets, donorRows);
    if (refundRows.length > 0) await appendRefundRows(sheets, refundRows);
  }

  if (refundFailed > 0) {
    console.warn(`[sync] ${refundFailed} refund failure(s) — re-run with --date ${syncDate} to retry.`);
  }

  return { created, updated, failed, dailyRefundTotal, dailyRefundCount, refundFailed };
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => {
    console.error('[sync] Fatal:', err.response?.data || err.message);
    process.exit(1);
  });
}