/**
 * sync.js — Stripe → HubSpot nightly donor sync + Google Sheets reporting
 *
 * Replaces the manual CSV export step from backfill.js.
 * Pulls succeeded charges directly from the Stripe API and upserts
 * HubSpot contacts with up-to-date donation totals.
 *
 * After every sync it also appends a daily summary row to a Google Sheet:
 *   Date | Daily Total ($) | Daily Donor Count | New Donors | Cumulative Total ($) | Cumulative Donors
 *
 * TWO MODES (selected automatically):
 *
 *   Full sync   — no .last_sync file exists (first run).
 *                 Fetches ALL Stripe history and REPLACES totalindividualdonations.
 *                 Sheets row will reflect all-time totals rather than a single day.
 *
 *   Incremental — .last_sync exists (every subsequent nightly run).
 *                 Fetches only charges created since the last run and ADDS
 *                 the new amounts to existing HubSpot totals.
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
 *   node sync.js
 *
 *   Force a full re-sync regardless of .last_sync:
 *   node sync.js --full
 *
 * DEPENDENCIES:
 *   npm install dotenv axios stripe googleapis
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const axios  = require('axios');
const Stripe = require('stripe');
const { google } = require('googleapis');

// ─── Config ────────────────────────────────────────────────────────────────

const HUBSPOT_BASE  = 'https://api.hubapi.com';
const DELAY_MS      = 150;   // stay under HubSpot's 100 req/10 s rate limit
const LAST_RUN_FILE = path.join(__dirname, '.last_sync');
const SHEET_TAB     = 'Sheet1'; // change if your tab has a different name

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

/** Returns a YYYY-MM-DD string for a given Date object */
function toDateString(date) {
  return date.toISOString().split('T')[0];
}

/** Returns yesterday's YYYY-MM-DD string in UTC */
function yesterdayDateString() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return toDateString(d);
}

// ─── Timestamp persistence ─────────────────────────────────────────────────

function getLastSyncTimestamp() {
  try {
    if (fs.existsSync(LAST_RUN_FILE)) {
      const val = parseInt(fs.readFileSync(LAST_RUN_FILE, 'utf8').trim(), 10);
      if (!isNaN(val)) return val;
    }
  } catch { /* treat as first run */ }
  return null;
}

function saveLastSyncTimestamp(ts) {
  fs.writeFileSync(LAST_RUN_FILE, String(ts));
}

// ─── Stripe ────────────────────────────────────────────────────────────────

/**
 * Fetch all succeeded Stripe charges, optionally filtered by creation time.
 * Automatically paginates through the full result set.
 */
async function fetchCharges(stripe, since) {
  const charges = [];
  let startingAfter;

  do {
    const params = { limit: 100 };
    if (since) params.created = { gte: since };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.charges.list(params);
    charges.push(...page.data.filter((c) => c.status === 'succeeded'));
    startingAfter = page.has_more ? page.data.at(-1).id : undefined;
  } while (startingAfter);

  return charges;
}

function isValidEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email)) return false;
  const typoTLDs = ['.con', '.cmo', '.ocm', '.nte', '.rog', '.ogr', '.coj', '.cpm'];
  if (typoTLDs.some((typo) => email.endsWith(typo))) return false;
  return true;
}

/**
 * Group charges by email.
 * Returns Map<email, { totalAmount, latestCreated, latestAmount, cardName }>
 */
function buildDonorMap(charges) {
  const donors = new Map();

  for (const charge of charges) {
    const email = (
      charge.billing_details?.email ||
      charge.receipt_email ||
      ''
    ).toLowerCase().trim();

    if (!email) continue;

    if (!isValidEmail(email)) {
      console.warn(`[sync] Skipping malformed email on charge ${charge.id}: "${email}"`);
      continue;
    }

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
 * Create or update a HubSpot contact.
 *
 * isFullSync = true  → replace totalindividualdonations
 * isFullSync = false → increment totalindividualdonations
 *
 * Returns { action: 'created'|'updated', isNew: boolean }
 */
async function upsertContact(email, donor, isFullSync) {
  const { totalAmount, latestCreated, latestAmount, cardName } = donor;
  const { firstname, lastname } = splitName(cardName);
  const hubspotDate = toHubSpotDate(latestCreated);

  const existing = await findContactByEmail(email);
  await sleep(DELAY_MS);

  let newTotal;
  if (isFullSync || !existing) {
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
    return { action: 'updated', isNew: false };
  } else {
    await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts`,
      { properties: { email, firstname, lastname, ...props } },
      { headers: hubspotHeaders }
    );
    return { action: 'created', isNew: true };
  }
}

// ─── Google Sheets ─────────────────────────────────────────────────────────

/**
 * Returns an authenticated Google Sheets client.
 * Throws if the env var is missing or malformed.
 */
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
 * Read the last data row of columns E and F (cumulative totals) from the sheet.
 * Returns { cumulativeTotal: number, cumulativeDonors: number }.
 * Returns zeroes if the sheet has no data rows yet (only a header row, or empty).
 */
async function getLastCumulativeTotals(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!E:F`,
  });

  const rows = res.data.values || [];
  // Row 0 is the header; we want the last data row (index >= 1)
  if (rows.length <= 1) return { cumulativeTotal: 0, cumulativeDonors: 0 };

  const lastRow = rows[rows.length - 1];
  return {
    cumulativeTotal:  parseFloat(lastRow[0]) || 0,
    cumulativeDonors: parseInt(lastRow[1],  10) || 0,
  };
}

/**
 * Ensure the header row exists. If the sheet is empty we write it first.
 */
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
 * Append one summary row to the Google Sheet.
 *
 * @param {object} summary
 * @param {string} summary.date            — YYYY-MM-DD
 * @param {number} summary.dailyTotal      — total $ donated in this sync window
 * @param {number} summary.dailyDonorCount — total transaction count in this sync window
 * @param {number} summary.newDonorCount   — contacts created (first-ever donation)
 */
async function appendSheetRow(summary) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    console.log('[sheets] GOOGLE_SHEET_ID not set — skipping sheet update.');
    return;
  }

  let sheets;
  try {
    sheets = await getSheetsClient();
  } catch (err) {
    console.warn(`[sheets] Could not authenticate — skipping sheet update. (${err.message})`);
    return;
  }

  await ensureSheetHeader(sheets);

  const { cumulativeTotal, cumulativeDonors } = await getLastCumulativeTotals(sheets);

  const newCumulativeTotal   = parseFloat((cumulativeTotal   + summary.dailyTotal).toFixed(2));
  const newCumulativeDonors  = cumulativeDonors + summary.newDonorCount;

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
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

  console.log(`[sheets] Row appended → ${summary.date} | $${summary.dailyTotal.toFixed(2)} | ${summary.dailyDonorCount} transactions | ${summary.newDonorCount} new donors | cumulative $${newCumulativeTotal.toFixed(2)} across ${newCumulativeDonors} donors`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function run() {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) throw new Error('HUBSPOT_ACCESS_TOKEN not set in .env');
  if (!process.env.STRIPE_SECRET_KEY)    throw new Error('STRIPE_SECRET_KEY not set in .env');

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const forceFullSync = process.argv.includes('--full');
  const since         = forceFullSync ? null : getLastSyncTimestamp();
  const isFullSync    = since === null;
  const runTimestamp  = Math.floor(Date.now() / 1000);

  // Label the sheet row with yesterday's date on incremental runs,
  // or today's date on a full sync (since it covers all time).
  const rowDate = isFullSync ? toDateString(new Date()) : yesterdayDateString();

  console.log(`[sync] Mode: ${isFullSync ? 'FULL (all-time)' : `INCREMENTAL (since ${new Date(since * 1000).toISOString()})`}`);

  const charges = await fetchCharges(stripe, since);
  console.log(`[sync] ${charges.length} succeeded charge(s) fetched from Stripe`);

  const donorMap = buildDonorMap(charges);
  console.log(`[sync] ${donorMap.size} unique donor(s) to process`);

  if (donorMap.size === 0) {
    console.log('[sync] Nothing to do.');
    saveLastSyncTimestamp(runTimestamp);

    // Still write a zero-row to the sheet so every day has a record
    await appendSheetRow({
      date:            rowDate,
      dailyTotal:      0,
      dailyDonorCount: 0,
      newDonorCount:   0,
    });

    return { created: 0, updated: 0, failed: 0 };
  }

  let created = 0, updated = 0, failed = 0;
  let dailyTotal = 0;

  for (const [email, donor] of donorMap) {
    try {
      const { action, isNew } = await upsertContact(email, donor, isFullSync);
      dailyTotal = parseFloat((dailyTotal + donor.totalAmount).toFixed(2));

      if (action === 'created') {
        console.log(`  ✓ CREATED  ${email} — $${donor.totalAmount}`);
        created++;
      } else {
        console.log(`  ✓ UPDATED  ${email} — +$${donor.totalAmount}${isFullSync ? ' (replaced)' : ' (added)'}`);
        updated++;
      }
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error(`  ✗ FAILED   ${email} — ${msg}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  // Only advance the timestamp if there were no failures.
  if (failed === 0) {
    saveLastSyncTimestamp(runTimestamp);
    console.log(`\n[sync] Timestamp saved → next run will start from ${new Date(runTimestamp * 1000).toISOString()}`);
  } else {
    console.warn(`\n[sync] ${failed} failure(s) — timestamp NOT advanced. Re-run to retry.`);
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(`Sync complete.`);
  console.log(`  Created: ${created}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`────────────────────────────────────────\n`);

  // Append daily summary to Google Sheet (skipped gracefully if env vars absent)
  await appendSheetRow({
    date:            rowDate,
    dailyTotal,
    dailyDonorCount: donorMap.size,
    newDonorCount:   created,   // "created" contacts are first-time donors
  });

  return { created, updated, failed };
}

module.exports = { run };

// Allow running directly: node sync.js [--full]
if (require.main === module) {
  run().catch((err) => {
    console.error('[sync] Fatal:', err.response?.data || err.message);
    process.exit(1);
  });
}