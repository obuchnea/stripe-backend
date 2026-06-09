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
 * After each successful sync, a summary email is sent with an HTML table of
 * the day's stats and a CSV attachment of that day's donor rows.
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
 * No .last_sync file is used — the time window is always deterministic
 * (yesterday), so every run is idempotent and self-contained.
 *
 * FIRST RUN / EMPTY SHEET (automatic):
 *   If the Google Sheet has no data rows when the script runs, it triggers a
 *   full historical backfill automatically.
 *
 * BACKFILL MODE (manual):
 *   node sync.js --date YYYY-MM-DD
 *   Syncs a specific past date instead of yesterday.
 *
 * NOTE ON CALCULATED PROPERTIES:
 *   amount_left_to_donate, donation_limit_reached, and donation_compliance_status
 *   are HubSpot formula properties. They update automatically when
 *   totalindividualdonations changes. This script never writes to them.
 *
 * NOTE ON SHEET NUMBER FORMATTING:
 *   All numeric values are written as plain numbers (no $ or commas) so that
 *   Google Sheets stores them as true numbers. Apply currency/number formatting
 *   directly in the sheet via Format → Number.
 *
 * REQUIRED ENV VARS (.env):
 *   HUBSPOT_ACCESS_TOKEN
 *   STRIPE_SECRET_KEY
 *
 * OPTIONAL ENV VARS — omit to skip the relevant feature:
 *   GOOGLE_SHEET_ID                 — ID from the sheet URL
 *   GOOGLE_SERVICE_ACCOUNT_JSON     — full contents of the service account key JSON
 *   SMTP_USER                       — Gmail address to send from
 *   SMTP_PASS                       — Gmail App Password (16-char code)
 *   SUMMARY_EMAIL_TO                — recipient address for the daily summary email
 *
 * HOW TO RUN MANUALLY:
 *   node sync.js                        → syncs yesterday (or backfills if sheet is empty)
 *   node sync.js --date 2025-06-01      → syncs a specific date
 *
 * DEPENDENCIES:
 *   npm install dotenv axios stripe googleapis nodemailer
 */

require('dotenv').config();
const axios        = require('axios');
const Stripe       = require('stripe');
const { google }   = require('googleapis');
const nodemailer   = require('nodemailer');

// ─── Config ────────────────────────────────────────────────────────────────

const HUBSPOT_BASE      = 'https://api.hubapi.com';
const DELAY_MS          = 150;
const SHEET_TAB         = 'Summary';
const DONORS_SHEET_TAB  = 'Donors';
const REFUNDS_SHEET_TAB = 'Refunds';

const hubspotHeaders = {
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toHubSpotDate(unixTs) {
  const dateOnly = new Date(unixTs * 1000).toISOString().split('T')[0];
  return new Date(`${dateOnly}T00:00:00.000Z`).getTime();
}

function splitName(fullName = '') {
  if (!fullName.trim()) return { firstname: '', lastname: '' };
  const parts = fullName.trim().split(/\s+/);
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

function dayWindow(dateString) {
  const windowStart = Math.floor(new Date(`${dateString}T00:00:00.000Z`).getTime() / 1000);
  const windowEnd   = Math.floor(new Date(`${dateString}T23:59:59.999Z`).getTime() / 1000);
  return { windowStart, windowEnd };
}

function yesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split('T')[0];
}

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

/**
 * Safely parse a number from a sheet cell value, stripping any currency
 * formatting that may have been applied (e.g. "$2,300.00" → 2300).
 */
function parseSheetNumber(val) {
  return parseFloat(String(val || '').replace(/[$,\s]/g, '')) || 0;
}

// ─── Stripe — Charges ──────────────────────────────────────────────────────

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

async function enrichChargeAddress(stripe, charge) {
  const hasAddress = charge.billing_details?.address?.line1;
  let enriched = charge;

  if (!hasAddress) {
    try {
      enriched = await stripe.charges.retrieve(charge.id, {
        expand: ['payment_intent'],
      });
      await sleep(DELAY_MS);
    } catch (err) {
      console.warn(`[stripe] Could not enrich charge ${charge.id}: ${err.message}`);
      enriched = charge;
    }
  } else {
    // Still need to expand payment_intent for phone lookup
    try {
      enriched = await stripe.charges.retrieve(charge.id, {
        expand: ['payment_intent'],
      });
      await sleep(DELAY_MS);
    } catch (_) {}
  }

  // Try to get phone from the Checkout Session linked to the Payment Intent
  let phone = '';
  const paymentIntentId = enriched.payment_intent?.id || enriched.payment_intent;

  if (paymentIntentId) {
    try {
      // Find the checkout session for this payment intent
      const sessions = await stripe.checkout.sessions.list({
        payment_intent: paymentIntentId,
        limit: 1,
        expand: ['data.custom_fields'],
      });
      await sleep(DELAY_MS);

      if (sessions.data.length > 0) {
        const session = sessions.data[0];

        // 1. Check phone_number_collection (Stripe's built-in phone field)
        phone = session.customer_details?.phone || '';

        // 2. If still empty, check custom fields (if you used a custom phone field)
        if (!phone && session.custom_fields?.length) {
          const phoneField = session.custom_fields.find(
            f => f.key?.toLowerCase().includes('phone') ||
                 f.label?.custom?.toLowerCase().includes('phone')
          );
          phone = phoneField?.text?.value || phoneField?.dropdown?.value || '';
        }
      }
    } catch (err) {
      console.warn(`[stripe] Could not fetch checkout session for PI ${paymentIntentId}: ${err.message}`);
    }
  }

  // Fallback to customer phone if session lookup failed
  if (!phone && enriched.customer) {
    try {
      const customer = await stripe.customers.retrieve(enriched.customer);
      await sleep(DELAY_MS);
      phone = customer.phone || '';
    } catch (err) {
      console.warn(`[stripe] Could not retrieve customer for charge ${charge.id}: ${err.message}`);
    }
  }

  enriched._customerPhone = phone;
  return enriched;
}

function isValidEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email)) return false;
  const typoTLDs = ['.con', '.cmo', '.ocm', '.nte', '.rog', '.ogr', '.coj', '.cpm'];
  if (typoTLDs.some((typo) => email.endsWith(typo))) return false;
  return true;
}

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

function buildDonorMap(charges) {
  const donors = new Map();

  for (const charge of charges) {
    const email = emailFromCharge(charge);
    if (!email) continue;

    const amount   = charge.amount / 100;
    const created  = charge.created;
    const cardName = charge.billing_details?.name || '';
    const address = charge.payment_method?.billing_details?.address || charge.billing_details?.address || {};
    const phone = charge._customerPhone || charge.billing_details?.phone || '';

    if (donors.has(email)) {
      const d = donors.get(email);
      d.totalAmount = parseFloat((d.totalAmount + amount).toFixed(2));
      if (created > d.latestCreated) {
        d.latestCreated = created;
        d.latestAmount  = amount;
        d.cardName      = cardName || d.cardName;
        d.id            = charge.id;
        d.address       = address;
        d.phone         = phone;
      }
    } else {
      donors.set(email, {
        totalAmount: amount,
        latestCreated: created,
        latestAmount: amount,
        cardName,
        id: charge.id,
        address: address,
        phone: phone
      });
    }
  }

  return donors;
}

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
      amount:    refund.amount / 100,
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

async function isSheetEmpty(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!A:A`,
  });
  const rows = res.data.values || [];
  return rows.length <= 1;
}

/**
 * Read the last data row and extract cumulative totals from columns H and I.
 * Uses parseSheetNumber to safely handle any residual currency formatting.
 *
 * Summary tab column layout:
 *   A: Date                   B: Daily Total ($)      C: Daily Donor Count
 *   D: New Donors             E: Daily Refunds ($)    F: Daily Refund Count
 *   G: Net Daily ($)          H: Cumulative Total ($) I: Cumulative Donors
 */
async function getLastCumulativeTotals(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!A:I`,
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return { cumulativeTotal: 0, cumulativeDonors: 0 };

  const lastRow = rows[rows.length - 1];
  return {
    cumulativeTotal:  parseSheetNumber(lastRow[7]),
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
 * All monetary values are written as plain numbers so Sheets stores them
 * as true numerics. Apply display formatting in the sheet via Format → Number.
 */
async function appendSheetRow(sheets, summary) {
  const { cumulativeTotal, cumulativeDonors } = await getLastCumulativeTotals(sheets);

  const dailyRefundTotal   = summary.dailyRefundTotal  || 0;
  const dailyRefundCount   = summary.dailyRefundCount  || 0;
  const netDaily           = parseFloat((summary.dailyTotal - dailyRefundTotal).toFixed(2));
  const newCumulativeTotal = parseFloat((cumulativeTotal + netDaily).toFixed(2));

  const newCumulativeDonors =
    summary.overrideCumDonors !== undefined
      ? summary.overrideCumDonors
      : cumulativeDonors + summary.newDonorCount;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SHEET_TAB}!A:I`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        summary.date,
        summary.dailyTotal,
        summary.dailyDonorCount,
        summary.newDonorCount,
        dailyRefundTotal,
        dailyRefundCount,
        netDaily,
        newCumulativeTotal,
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

  // Return the computed cumulative values so the email function can use them
  return { netDaily, newCumulativeTotal, newCumulativeDonors };
}

async function appendDonorRows(sheets, donorRows) {
  if (donorRows.length === 0) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range:         `${DONORS_SHEET_TAB}!A:H`,
    valueInputOption: 'RAW',
    requestBody: { values: donorRows },
  });

  console.log(`[sheets] ${donorRows.length} donor row(s) appended to ${DONORS_SHEET_TAB}`);
}

async function appendRefundRows(sheets, refundRows) {
  if (refundRows.length === 0) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range:         `${REFUNDS_SHEET_TAB}!A:G`,
    valueInputOption: 'RAW',
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

// ─── Email ─────────────────────────────────────────────────────────────────

/**
 * Send a daily summary email with an HTML stats table and a CSV attachment
 * of that day's donor rows.
 *
 * Silently skips if SMTP_USER, SMTP_PASS, or SUMMARY_EMAIL_TO are not set.
 *
 * @param {object} summary
 * @param {string}   summary.date
 * @param {number}   summary.dailyTotal
 * @param {number}   summary.dailyDonorCount
 * @param {number}   summary.newDonorCount
 * @param {number}   summary.dailyRefundTotal
 * @param {number}   summary.dailyRefundCount
 * @param {number}   summary.netDaily
 * @param {number}   summary.newCumulativeTotal
 * @param {number}   summary.newCumulativeDonors
 * @param {number}   summary.hubspotCreated
 * @param {number}   summary.hubspotUpdated
 * @param {number}   summary.failed
 * @param {Array}    summary.donorRows  — array of [date, email, first, last, amount, chargeId, phone, address]
 */
async function sendSummaryEmail(summary) {
  const { SMTP_USER, SMTP_PASS, SUMMARY_EMAIL_TO } = process.env;

  if (!SMTP_USER || !SMTP_PASS || !SUMMARY_EMAIL_TO) {
    console.log('[email] SMTP env vars not set — skipping summary email.');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  // ── HTML body ─────────────────────────────────────────────────────────────
  const row = (label, value) =>
    `<tr><td style="padding:6px 12px;border:1px solid #ddd;">${label}</td>` +
    `<td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold;">${value}</td></tr>`;

  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#960018;">Donation Summary — ${summary.date}</h2>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead>
          <tr style="background:#960018;color:white;">
            <th style="padding:8px 12px;text-align:left;">Metric</th>
            <th style="padding:8px 12px;text-align:left;">Value</th>
          </tr>
        </thead>
        <tbody>
          ${row('Daily Total',          `$${summary.dailyTotal.toFixed(2)}`)}
          ${row('Daily Donor Count',    summary.dailyDonorCount)}
          ${row('New Donors',           summary.newDonorCount)}
          ${row('Daily Refunds',        `-$${summary.dailyRefundTotal.toFixed(2)} (${summary.dailyRefundCount})`)}
          ${row('Net Daily',            `$${summary.netDaily.toFixed(2)}`)}
          ${row('Cumulative Total',     `$${summary.newCumulativeTotal.toFixed(2)}`)}
          ${row('Cumulative Donors',    summary.newCumulativeDonors)}
          ${row('HubSpot Created',      summary.hubspotCreated)}
          ${row('HubSpot Updated',      summary.hubspotUpdated)}
          ${row('Failures',             summary.failed)}
        </tbody>
      </table>
      <p style="font-size:12px;color:#888;margin-top:16px;">
        Donor details attached as CSV. This email was sent automatically by sync.js.
      </p>
    </div>
  `;

  // ── CSV attachment ────────────────────────────────────────────────────────
  // donorRows: [date, email, firstname, lastname, amount, chargeId]
  const csvHeader = 'Date,Email,First Name,Last Name,Amount ($),Charge ID,Phone,Street Address\n';
  const csvBody   = summary.donorRows
    .map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const csvContent = csvHeader + csvBody;

  // ── Send ──────────────────────────────────────────────────────────────────
  try {
    await transporter.sendMail({
      from:    SMTP_USER,
      to:      SUMMARY_EMAIL_TO,
      subject: `Donation Summary — ${summary.date}`,
      html,
      attachments: [
        {
          filename:    `donors-${summary.date}.csv`,
          content:     csvContent,
          contentType: 'text/csv',
        },
      ],
    });
    console.log(`[email] Summary email sent to ${SUMMARY_EMAIL_TO}`);
  } catch (err) {
    console.warn(`[email] Failed to send summary email: ${err.message}`);
  }
}

// ─── Process refunds for a given day ───────────────────────────────────────

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
        r.amount,
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

  // Enrich charges that are missing address data with a full retrieve
  console.log('[backfill] Enriching charges with address data...');
  const enrichedCharges = [];
  for (const charge of allCharges) {
    const enriched = await enrichChargeAddress(stripe, charge);
    enrichedCharges.push(enriched);
  }
  console.log('[backfill] Enrichment complete.\n');

  const chargeCache = new Map(enrichedCharges.map((c) => [c.id, c]));

  const chargesByDate = new Map();
  for (const charge of enrichedCharges) {
    const dateStr = new Date(charge.created * 1000).toISOString().split('T')[0];
    if (!chargesByDate.has(dateStr)) chargesByDate.set(dateStr, []);
    chargesByDate.get(dateStr).push(charge);
  }

  const refundsByDate = new Map();
  for (const refund of allRefunds) {
    const dateStr = new Date(refund.created * 1000).toISOString().split('T')[0];
    if (!refundsByDate.has(dateStr)) refundsByDate.set(dateStr, []);
    refundsByDate.get(dateStr).push(refund);
  }

  const allDates    = new Set([...chargesByDate.keys(), ...refundsByDate.keys()]);
  const yesterday   = yesterdayUTC();
  const sortedDates = [...allDates].sort().filter((d) => d <= yesterday);

  console.log(`[backfill] ${sortedDates.length} calendar day(s) to process ` +
              `(${sortedDates[0]} → ${sortedDates.at(-1)}).\n`);

  const allTimeSeenEmails = new Set();
  let totalCreated = 0, totalUpdated = 0, totalFailed = 0, totalRefundFailed = 0;

  for (let i = 0; i < sortedDates.length; i++) {
    const dateStr    = sortedDates[i];
    const dayCharges = chargesByDate.get(dateStr) || [];
    const dayRefunds = refundsByDate.get(dateStr) || [];
    const donorMap   = buildDonorMap(dayCharges);

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

    for (const [email, donor] of donorMap) {
      try {
        const { action } = await upsertContact(email, donor);
        dailyTotal = parseFloat((dailyTotal + donor.totalAmount).toFixed(2));
        if (action === 'created') { dayCreated++; } else { dayUpdated++; }

        const { firstname, lastname } = splitName(donor.cardName);
        const addr = donor.address || {};
        const streetAddress = [addr.line1, addr.line2].filter(Boolean).join(' ');

        donorRows.push([
          dateStr, email, firstname, lastname,
          donor.totalAmount, donor.id,
          donor.phone || '',
          streetAddress,
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
          refundRows.push([dateStr, r.email, r.amount, r.chargeId, r.refundId, typeLabel, action]);
        } catch (err) {
          const msg = err.response?.data?.message || err.message;
          console.error(`  ✗ REFUND FAILED   ${r.email} — ${msg}`);
          dayRefundFailed++;
        }
        await sleep(DELAY_MS);
      }

      totalRefundFailed += dayRefundFailed;
    }

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

  // Enrich any charges missing address data
  const enrichedCharges = await Promise.all(
    charges.map(c => enrichChargeAddress(stripe, c))
  );

  const donorMap = buildDonorMap(enrichedCharges);
  console.log(`[sync] ${donorMap.size} unique donor(s) to process`);

  const chargeCache = new Map(charges.map((c) => [c.id, c]));

  let historicalEmailSet = new Set();
  if (sheets) {
    const allCharges = await fetchAllCharges(stripe, { silent: true });
    historicalEmailSet = buildHistoricalEmailSet(allCharges, syncDate);
    for (const c of allCharges) {
      if (!chargeCache.has(c.id)) chargeCache.set(c.id, c);
    }
    console.log(`[sync] Historical baseline: ${historicalEmailSet.size} unique donors before ${syncDate}`);
  }

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
      const addr = donor.address || {};
      const streetAddress = [addr.line1, addr.line2].filter(Boolean).join(' ');

      donorRows.push([
        syncDate, email, firstname, lastname,
        donor.totalAmount, donor.id,
        donor.phone || '',
        streetAddress,
      ]);

    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error(`  ✗ FAILED   ${email} — ${msg}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  const newDonorCount = [...donorMap.keys()].filter(e => !historicalEmailSet.has(e)).length;

  const { dailyRefundTotal, dailyRefundCount, refundRows, refundFailed } =
    await processDayRefunds(stripe, windowStart, windowEnd, syncDate, chargeCache);

  console.log(`\n────────────────────────────────────────`);
  console.log(`Sync complete for ${syncDate}.`);
  console.log(`  Daily donors   : ${donorMap.size} (${newDonorCount} first-time)`);
  console.log(`  HubSpot created: ${created}`);
  console.log(`  HubSpot updated: ${updated}`);
  console.log(`  Charge failures: ${failed}`);
  console.log(`  Refunds        : ${dailyRefundCount} (-$${dailyRefundTotal.toFixed(2)})`);
  console.log(`  Refund failures: ${refundFailed}`);
  console.log(`────────────────────────────────────────\n`);

  if (failed > 0) {
    console.warn(`[sync] ${failed} charge failure(s) — sheet rows NOT written. Re-run with --date ${syncDate} to retry.`);
  } else if (sheets) {
    await ensureSheetHeaders(sheets);

    const { netDaily, newCumulativeTotal, newCumulativeDonors } = await appendSheetRow(sheets, {
      date:            syncDate,
      dailyTotal,
      dailyDonorCount: donorMap.size,
      newDonorCount,
      dailyRefundTotal,
      dailyRefundCount,
    });

    if (donorRows.length > 0)  await appendDonorRows(sheets, donorRows);
    if (refundRows.length > 0) await appendRefundRows(sheets, refundRows);

    // Send daily summary email
    await sendSummaryEmail({
      date:                syncDate,
      dailyTotal,
      dailyDonorCount:     donorMap.size,
      newDonorCount,
      dailyRefundTotal,
      dailyRefundCount,
      netDaily,
      newCumulativeTotal,
      newCumulativeDonors,
      hubspotCreated:      created,
      hubspotUpdated:      updated,
      failed,
      donorRows,
    });
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