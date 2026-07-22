/**
 * sync.js — Stripe → HubSpot nightly donor sync + Google Sheets reporting
 *
 * Designed to run at 12:01 AM EDT via Railway Cron ("1 4 * * *").
 * Each run syncs all succeeded Stripe charges from the PREVIOUS calendar day
 * (yesterday 00:00:00 EDT → 23:59:59 EDT), processes any refunds issued that
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
 * HOW REFERRAL ATTRIBUTION WORKS:
 *   Donations are attributed to referrers on a per-transaction basis. When a
 *   donor clicks a referral link (e.g. ?ref=jane-smith) and completes a
 *   checkout, the ref value must be stored in the Stripe Checkout Session's
 *   metadata under the key "referrer_id". This script reads that value from
 *   each session and writes it as a "Referrer" column in the Donors sheet tab.
 *
 *   Attribution rules:
 *     - Every charge is independently attributed to whichever ref was on that
 *       session. A donor can appear in multiple referrers' totals over time.
 *     - If a donor makes multiple charges on the same calendar day, the
 *       referrer from the most recent charge is recorded for that day's row.
 *     - If no ref was present, the Referrer column is left blank.
 *     - Attribution is never stored on the HubSpot contact — it lives only
 *       in the Donors sheet tab, queryable via SUMIF or a pivot table.
 *
 *   PER-REFERRER SHEETS: on top of the shared Donors tab above, each night
 *   this script also calls into referralAttribution.js, which fans referred
 *   donations AND referred membership signups out into each individual
 *   referrer's own Google Sheet (created on demand — see referralSheets.js /
 *   the /api/referral/* routes in server.js), and refreshes their
 *   leaderboard position there. That step is independent of GOOGLE_SHEET_ID
 *   and runs even if the master admin sheet isn't configured.
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
 *   GOOGLE_SHARED_DRIVE_ID          — Shared Drive ID for per-referrer sheets (see SETUP.md)
 *   RESEND_API_KEY                  — API key from resend.com
 *   RESEND_FROM                     — verified sender address (e.g. Donations <you@yourdomain.com>)
 *   SUMMARY_EMAIL_TO                — recipient address for the daily summary email
 *
 * HOW TO RUN MANUALLY:
 *   node sync.js                        → syncs yesterday (or backfills if sheet is empty)
 *   node sync.js --date 2025-06-01      → syncs a specific date
 *
 * DEPENDENCIES:
 *   npm install dotenv axios stripe googleapis luxon resend
 */

require('dotenv').config();
const axios        = require('axios');
const Stripe       = require('stripe');
const { google }   = require('googleapis');
const { DateTime } = require('luxon');
const readline     = require('readline/promises');
const referralAttribution = require('./referralAttribution');

// ─── Config ────────────────────────────────────────────────────────────────

const HUBSPOT_BASE      = 'https://api.hubapi.com';
const DELAY_MS          = 150;
const SHEET_TAB         = 'Summary';
const DONORS_SHEET_TAB  = 'Donors';
const REFUNDS_SHEET_TAB = 'Refunds';
const RIDINGS_SHEET_TAB = 'Ridings';
const TZ                = 'America/Toronto'; // handles EDT/EST automatically
const INTERACTIVE       = process.argv.includes('--interactive') && process.stdin.isTTY;

if (process.argv.includes('--interactive') && !process.stdin.isTTY) {
  console.warn(
    '[sync] --interactive was passed but no terminal is attached (e.g. running under cron) — ' +
    'falling back to auto-skip for malformed emails instead of hanging.'
  );
}

const hubspotHeaders = {
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toHubSpotDate(unixTs) {
  const dateOnly = DateTime.fromSeconds(unixTs, { zone: TZ }).toFormat('yyyy-MM-dd');
  return new Date(`${dateOnly}T00:00:00.000Z`).getTime();
}

function splitName(fullName = '') {
  if (!fullName.trim()) return { firstname: '', lastname: '' };
  const parts = fullName.trim().split(/\s+/);
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

function yesterdayUTC() {
  return DateTime.now().setZone(TZ).minus({ days: 1 }).toFormat('yyyy-MM-dd');
}

function dayWindow(dateString) {
  const start = DateTime.fromISO(dateString, { zone: TZ }).startOf('day');
  const end   = start.plus({ days: 1 });
  return {
    windowStart: Math.floor(start.toSeconds()),
    windowEnd:   Math.floor(end.toSeconds()) - 1,
  };
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

  // Try to get phone and referrer_id from the Checkout Session linked to the Payment Intent
  let phone      = '';
  let referrerId = '';
  const paymentIntentId = enriched.payment_intent?.id || enriched.payment_intent;

  if (paymentIntentId) {
  try {
    const sessions = await stripe.checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 1,
      expand: ['data.custom_fields'],
    });
    await sleep(DELAY_MS);

    if (sessions.data.length > 0) {
      const session = sessions.data[0];
      phone      = session.customer_details?.phone || '';
      if (!phone && session.custom_fields?.length) {
        const phoneField = session.custom_fields.find(
          f => f.key?.toLowerCase().includes('phone') ||
               f.label?.custom?.toLowerCase().includes('phone')
        );
        phone = phoneField?.text?.value || phoneField?.dropdown?.value || '';
      }
      referrerId = session.metadata?.referrer_id || '';
    }

    // Always fall back to Payment Intent metadata regardless of session result
    if (!referrerId) {
      referrerId = enriched.payment_intent?.metadata?.referrer_id || '';
    }

  } catch (err) {
    console.warn(`[stripe] Could not fetch checkout session for PI ${paymentIntentId}: ${err.message}`);
    // Still try PI metadata even if session lookup threw
    referrerId = enriched.payment_intent?.metadata?.referrer_id || '';
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

  enriched._alreadySynced = enriched.payment_intent?.metadata?.hubspot_synced === 'true';
  enriched._customerPhone = phone;
  enriched._referrerId    = referrerId;
  return enriched;
}

function isValidEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email)) return false;
  const typoTLDs = ['.con', '.cmo', '.ocm', '.nte', '.rog', '.ogr', '.coj', '.cpm'];
  if (typoTLDs.some((typo) => email.endsWith(typo))) return false;
  return true;
}

async function promptForCorrectedEmail(charge, rawEmail) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n──────────────────────────────────────────');
    console.log(`⚠ Malformed email on charge ${charge.id}`);
    console.log(`   Raw value: "${rawEmail}"`);
    console.log(`   Amount:    $${(charge.amount / 100).toFixed(2)}`);
    console.log(`   Name:      ${charge.billing_details?.name || '(none)'}`);
    console.log('──────────────────────────────────────────');

    while (true) {
      const answer = (
        await rl.question('Enter corrected email (or press Enter to skip this donor): ')
      ).trim().toLowerCase();

      if (!answer) {
        console.log(`[sync] Skipping charge ${charge.id} — no correction provided.\n`);
        return null;
      }

      if (isValidEmail(answer)) {
        console.log(`[sync] Using corrected email "${answer}" for charge ${charge.id}.\n`);
        return answer;
      }

      console.log(`"${answer}" still doesn't look valid — try again, or press Enter to skip.`);
    }
  } finally {
    rl.close();
  }
}

async function emailFromCharge(charge, { interactive = INTERACTIVE } = {}) {
  const raw = (
    charge.billing_details?.email ||
    charge.receipt_email ||
    ''
  ).toLowerCase().trim();

  if (!raw) return null;

  if (isValidEmail(raw)) return raw;

  console.warn(`[sync] Malformed email on charge ${charge.id}: "${raw}"`);

  if (interactive) {
    return promptForCorrectedEmail(charge, raw);
  }

  console.warn(`[sync] Skipping charge ${charge.id} (re-run with --interactive to fix these manually).`);
  return null;
}

async function buildDonorMap(charges) {
  const donors = new Map();

  for (const charge of charges) {
    const email = await emailFromCharge(charge);
    if (!email) continue;

    const amount        = charge.amount / 100;
    const alreadySynced = charge._alreadySynced === true;
    const created       = charge.created;
    const cardName      = charge.billing_details?.name || '';
    const address       = charge.payment_method?.billing_details?.address || charge.billing_details?.address || {};
    const phone         = charge._customerPhone || charge.billing_details?.phone || '';
    const referrerId    = charge._referrerId || '';

    if (donors.has(email)) {
      const d = donors.get(email);
      d.totalAmount = parseFloat((d.totalAmount + amount).toFixed(2));
      if (!alreadySynced) {
        d.unsyncedAmount = parseFloat((d.unsyncedAmount + amount).toFixed(2));
      }
      if (created > d.latestCreated) {
        d.latestCreated = created;
        d.latestAmount  = amount;
        d.cardName      = cardName || d.cardName;
        d.id            = charge.id;
        d.address       = address;
        d.phone         = phone;
        d.referrerId    = referrerId || d.referrerId;
      }
    } else {
      donors.set(email, {
        totalAmount: amount,
        unsyncedAmount: alreadySynced ? 0 : amount,
        latestCreated: created,
        latestAmount: amount,
        cardName,
        id: charge.id,
        address,
        phone,
        referrerId,
      });
    }
  }

  return donors;
}

async function buildHistoricalEmailSet(allCharges, beforeDate) {
  const seen = new Set();
  for (const charge of allCharges) {
    const chargeDate = DateTime.fromSeconds(charge.created, { zone: TZ }).toFormat('yyyy-MM-dd');
    if (chargeDate < beforeDate) {
      const email = await emailFromCharge(charge, { interactive: false }); // never prompt for historical baseline
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
    const email  = await emailFromCharge(charge);
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
      properties: ['email', 'totalindividualdonations', 'is_donor', 'zip'],
      limit: 1,
    },
    { headers: hubspotHeaders }
  );
  return res.data.results[0] || null;
}

async function upsertContact(email, donor) {
  const { totalAmount, unsyncedAmount, latestCreated, latestAmount, cardName } = donor;
  const { firstname, lastname } = splitName(cardName);
  const hubspotDate = toHubSpotDate(latestCreated);

  const existing = await findContactByEmail(email);
  await sleep(DELAY_MS);

  let newTotal;
  if (!existing) {
    newTotal = unsyncedAmount;
  } else {
    const currentTotal = parseFloat(existing.properties.totalindividualdonations || 0);
    newTotal = parseFloat((currentTotal + unsyncedAmount).toFixed(2));
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

/**
 * Fetch every contact that has the properties we need, paginated via `after`.
 * No filtering here — we skip contacts with a blank `riding` later, once
 * we're grouping, so this stays a single reusable fetch.
 */
async function fetchAllContactsForRidings() {
  const contacts = [];
  let after;

  console.log('[ridings] Fetching all HubSpot contacts...');

  do {
    const params = {
      limit: 100,
      properties: 'riding,is_volunteer,is_donor,totalindividualdonations,createdate,email',
    };
    if (after) params.after = after;

    const res = await axios.get(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
      headers: hubspotHeaders,
      params,
    });

    contacts.push(...res.data.results);
    after = res.data.paging?.next?.after;

    await sleep(DELAY_MS);
  } while (after);

  console.log(`[ridings] ${contacts.length} contact(s) fetched.`);
  return contacts;
}

/**
 * Batch-fetch is_volunteer/is_donor property history for a list of contact
 * IDs (100 per HubSpot batch/read call). Only call this with IDs for
 * contacts that are CURRENTLY true on at least one of the two properties —
 * no point paying for history on someone who was never a volunteer/donor.
 *
 * Returns Map<contactId, { is_volunteer: [...history entries], is_donor: [...] }>
 */
async function fetchPropertyHistoryBatch(contactIds) {
  const results = new Map();
  const BATCH_SIZE = 100;

  for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
    const batchIds = contactIds.slice(i, i + BATCH_SIZE);
    if (batchIds.length === 0) continue;

    const res = await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/batch/read`,
      {
        inputs: batchIds.map((id) => ({ id })),
        properties: ['is_volunteer', 'is_donor'],
        propertiesWithHistory: ['is_volunteer', 'is_donor'],
      },
      { headers: hubspotHeaders }
    );

    for (const contact of res.data.results) {
      results.set(contact.id, contact.propertiesWithHistory || {});
    }

    await sleep(DELAY_MS);
  }

  return results;
}

/**
 * Given a property's history entries (unordered), find the timestamp of the
 * MOST RECENT false→true transition. Handles multiple flips (e.g. donor
 * refunded to $0, then donates again later) by walking chronologically and
 * remembering the last time the value flipped up. Returns null if the
 * property was never true.
 */
function getMostRecentTrueTransitionTimestamp(historyEntries) {
  if (!historyEntries || historyEntries.length === 0) return null;

  const sorted = [...historyEntries].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  let lastTransitionTs = null;
  let prevWasTrue = false;

  for (const entry of sorted) {
    const isTrue = String(entry.value).toLowerCase() === 'true';
    if (isTrue && !prevWasTrue) {
      lastTransitionTs = entry.timestamp;
    }
    prevWasTrue = isTrue;
  }

  return lastTransitionTs;
}

function emptyRidingRow() {
  return {
    totalContacts: 0,
    newContactsPastMonth: 0,
    newContactsYesterday: 0,
    totalVolunteers: 0,
    newVolunteersPastMonth: 0,
    newVolunteersYesterday: 0,
    totalDonors: 0,
    newDonorsPastMonth: 0,
    newDonorsYesterday: 0,
    totalDonations: 0,
    newDonationsPastMonth: 0,
    newDonationsYesterday: 0,
  };
}

/** Trailing 30-day window ending at the end of syncDate (inclusive). */
function pastMonthWindow(syncDate) {
  const end = DateTime.fromISO(syncDate, { zone: TZ }).endOf('day');
  const start = end.minus({ days: 29 }).startOf('day');
  return { start, end };
}

/**
 * Full nightly recompute of every riding's row. Pulls all HubSpot contacts
 * + a month of Stripe charges, and returns Map<ridingName, rowObject>.
 */
async function buildRidingsData(stripe, syncDate) {
  const { windowStart: yStart, windowEnd: yEnd } = dayWindow(syncDate);
  const yStartDT = DateTime.fromSeconds(yStart, { zone: TZ });
  const yEndDT   = DateTime.fromSeconds(yEnd, { zone: TZ });
  const { start: pmStart, end: pmEnd } = pastMonthWindow(syncDate);

  const contacts = await fetchAllContactsForRidings();

  const ridings = new Map();
  const emailToRiding = new Map();
  const historyCandidateIds = [];

  // ── Pass 1: totals, new contacts, and collect who needs history lookup ──
  for (const contact of contacts) {
    const props = contact.properties;
    const riding = (props.riding || '').trim();
    if (!riding) continue; // no riding on file — not counted anywhere

    if (!ridings.has(riding)) ridings.set(riding, emptyRidingRow());
    const row = ridings.get(riding);

    row.totalContacts++;

    const isVolunteer = props.is_volunteer === 'true' || props.is_volunteer === true;
    const isDonor      = props.is_donor === 'true' || props.is_donor === true;
    const donationTotal = parseFloat(props.totalindividualdonations || 0);

    if (isVolunteer) row.totalVolunteers++;
    if (isDonor)      row.totalDonors++;
    row.totalDonations = parseFloat((row.totalDonations + donationTotal).toFixed(2));

    if (props.createdate) {
      const created = DateTime.fromISO(props.createdate, { zone: 'utc' }).setZone(TZ);
      if (created >= pmStart && created <= pmEnd) row.newContactsPastMonth++;
      if (created >= yStartDT && created <= yEndDT) row.newContactsYesterday++;
    }

    if (props.email) emailToRiding.set(props.email.toLowerCase().trim(), riding);
    if (isVolunteer || isDonor) historyCandidateIds.push(contact.id);
  }

  // ── Pass 2: new volunteers / new donors via property-history transitions ─
  console.log(`[ridings] Checking property history for ${historyCandidateIds.length} contact(s)...`);
  const historyMap = await fetchPropertyHistoryBatch(historyCandidateIds);

  for (const contact of contacts) {
    const props = contact.properties;
    const riding = (props.riding || '').trim();
    if (!riding) continue;

    const history = historyMap.get(contact.id);
    if (!history) continue;

    const row = ridings.get(riding);
    const isVolunteer = props.is_volunteer === 'true' || props.is_volunteer === true;
    const isDonor      = props.is_donor === 'true' || props.is_donor === true;

    if (isVolunteer) {
      const ts = getMostRecentTrueTransitionTimestamp(history.is_volunteer);
      if (ts) {
        const dt = DateTime.fromISO(ts, { zone: 'utc' }).setZone(TZ);
        if (dt >= pmStart && dt <= pmEnd) row.newVolunteersPastMonth++;
        if (dt >= yStartDT && dt <= yEndDT) row.newVolunteersYesterday++;
      }
    }

    if (isDonor) {
      const ts = getMostRecentTrueTransitionTimestamp(history.is_donor);
      if (ts) {
        const dt = DateTime.fromISO(ts, { zone: 'utc' }).setZone(TZ);
        if (dt >= pmStart && dt <= pmEnd) row.newDonorsPastMonth++;
        if (dt >= yStartDT && dt <= yEndDT) row.newDonorsYesterday++;
      }
    }
  }

  // ── Pass 3: donation dollars in-window, from actual Stripe charges ───────
  console.log('[ridings] Fetching Stripe charges for the past-month window...');
  const pmCharges = await fetchChargesForDay(
    stripe,
    Math.floor(pmStart.toSeconds()),
    Math.floor(pmEnd.toSeconds())
  ); // fetchChargesForDay just takes a window — reused as-is, no new Stripe call needed

  for (const charge of pmCharges) {
    const email = await emailFromCharge(charge, { interactive: false });
    if (!email || !emailToRiding.has(email)) continue;

    const riding = emailToRiding.get(email);
    const row    = ridings.get(riding);
    const amount = charge.amount / 100;

    row.newDonationsPastMonth = parseFloat((row.newDonationsPastMonth + amount).toFixed(2));
    if (charge.created >= yStart && charge.created <= yEnd) {
      row.newDonationsYesterday = parseFloat((row.newDonationsYesterday + amount).toFixed(2));
    }
  }

  return ridings;
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

async function ensureDonorsHeader(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${DONORS_SHEET_TAB}!A1:I1`,
  });

  const firstRow = res.data.values?.[0];
  if (!firstRow || firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${DONORS_SHEET_TAB}!A1:I1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'Date',
          'Email',
          'First Name',
          'Last Name',
          'Amount ($)',
          'Charge ID',
          'Phone',
          'Street Address',
          'Referrer',
        ]],
      },
    });
    console.log('[sheets] Donors header row written.');
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

async function ensureRidingsHeader(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${RIDINGS_SHEET_TAB}!A1:M1`,
  });

  const firstRow = res.data.values?.[0];
  if (!firstRow || firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${RIDINGS_SHEET_TAB}!A1:M1`, // fixed — was REFUNDS_SHEET_TAB
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'Riding',
          'Total Contacts',
          'New Contacts - Past Month',
          'New Contacts - Yesterday',
          'Total Volunteers',
          'New Volunteers - Past Month',
          'New Volunteers - Yesterday',
          'Total Donors',
          'New Donors - Past Month',
          'New Donors - Yesterday',
          'Total Donations ($)',
          'New Donations - Past Month ($)',
          'New Donations - Yesterday ($)',
        ]],
      },
    });
    console.log('[sheets] Ridings header row written.');
  }
}

async function ensureSheetHeaders(sheets) {
  await ensureSummaryHeader(sheets);
  await ensureDonorsHeader(sheets);
  await ensureRefundsHeader(sheets);
  await ensureRidingsHeader(sheets);
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
    range:         `${DONORS_SHEET_TAB}!A:I`,   // expanded from A:H to include Referrer column
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

/**
 * Clears every existing data row (everything below the header) and rewrites
 * the tab fresh. This is intentional, not a shortcut — Ridings is a snapshot,
 * so patching individual rows in place would let stale ridings linger and
 * risks numbers drifting if a riding is ever renamed in HubSpot.
 */
async function writeRidingsSheet(sheets, ridingsMap) {
  const sortedRidings = [...ridingsMap.keys()].sort();

  const rows = sortedRidings.map((riding) => {
    const r = ridingsMap.get(riding);
    return [
      riding,
      r.totalContacts,
      r.newContactsPastMonth,
      r.newContactsYesterday,
      r.totalVolunteers,
      r.newVolunteersPastMonth,
      r.newVolunteersYesterday,
      r.totalDonors,
      r.newDonorsPastMonth,
      r.newDonorsYesterday,
      r.totalDonations,
      r.newDonationsPastMonth,
      r.newDonationsYesterday,
    ];
  });

  await sheets.spreadsheets.values.clear({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${RIDINGS_SHEET_TAB}!A2:M`,
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${RIDINGS_SHEET_TAB}!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }

  console.log(`[sheets] Ridings tab rewritten — ${rows.length} riding(s).`);
}

// ─── Email ─────────────────────────────────────────────────────────────────

/**
 * Send a daily summary email with an HTML stats table and a CSV attachment
 * of that day's donor rows.
 *
 * Silently skips if RESEND_API_KEY or SUMMARY_EMAIL_TO are not set.
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
 * @param {Array}    summary.donorRows  — array of [date, email, first, last, amount, chargeId, phone, address, referrerId]
 */
async function sendSummaryEmail(summary) {
  const { RESEND_API_KEY, SUMMARY_EMAIL_TO, RESEND_FROM } = process.env;

  if (!RESEND_API_KEY || !SUMMARY_EMAIL_TO) {
    console.log('[email] RESEND_API_KEY or SUMMARY_EMAIL_TO not set — skipping summary email.');
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(RESEND_API_KEY);

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
          ${row('Cumulative Donors',    summary.newCumulativeDonors)}
        </tbody>
      </table>
      <p style="font-size:12px;color:#888;margin-top:16px;">
        Donor details attached as CSV. This email was sent automatically by sync.js.
      </p>
    </div>
  `;

  // ── CSV attachment ────────────────────────────────────────────────────────
  const csvHeader  = 'Date,Email,First Name,Last Name,Amount ($),Charge ID,Phone,Street Address,Referrer\n';
  const csvBody    = summary.donorRows
    .map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const csvContent = csvHeader + csvBody;

  // ── Send via Resend ───────────────────────────────────────────────────────
  try {
    const toAddresses = SUMMARY_EMAIL_TO.split(',').map(e => e.trim()).filter(Boolean);

    await resend.emails.send({
      from:    RESEND_FROM || 'Donations <onboarding@resend.dev>',
      to:      toAddresses,
      subject: `Donation Summary — ${summary.date}`,
      html,
      attachments: [{
        filename: `donors-${summary.date}.csv`,
        content:  Buffer.from(csvContent).toString('base64'),
      }],
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
  console.log('[backfill] NOTE: per-referrer Google Sheets are NOT populated during backfill —');
  console.log('[backfill] only the nightly/--date path calls referralAttribution.js. Referrers');
  console.log('[backfill] onboarded after this feature shipped will pick up new activity fine;');
  console.log('[backfill] pre-existing historical referrals won\'t retroactively appear.\n');

  const [allCharges, allRefunds] = await Promise.all([
    fetchAllCharges(stripe),
    fetchAllRefunds(stripe),
  ]);

  if (allCharges.length === 0) {
    console.log('[backfill] No charges found in Stripe — nothing to backfill.');
    return;
  }

  // Enrich charges with address, phone, and referrer_id data
  console.log('[backfill] Enriching charges with address, phone, and referrer data...');
  const enrichedCharges = [];
  for (const charge of allCharges) {
    const enriched = await enrichChargeAddress(stripe, charge);
    enrichedCharges.push(enriched);
  }
  console.log('[backfill] Enrichment complete.\n');

  const chargeCache = new Map(enrichedCharges.map((c) => [c.id, c]));

  const chargesByDate = new Map();
  for (const charge of enrichedCharges) {
    const dateStr = DateTime.fromSeconds(charge.created, { zone: TZ }).toFormat('yyyy-MM-dd');
    if (!chargesByDate.has(dateStr)) chargesByDate.set(dateStr, []);
    chargesByDate.get(dateStr).push(charge);
  }

  const refundsByDate = new Map();
  for (const refund of allRefunds) {
    const dateStr = DateTime.fromSeconds(refund.created, { zone: TZ }).toFormat('yyyy-MM-dd');
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
    const donorMap   = await buildDonorMap(dayCharges);

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
          donor.referrerId || '',
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

/**
 * Never throws — a Ridings failure shouldn't take down the donor sync.
 * syncDate is the date being processed ("yesterday" on a normal nightly
 * run, or the --date value during a manual backfill).
 */
async function syncRidingsTab(stripe, sheets, syncDate) {
  try {
    const ridingsData = await buildRidingsData(stripe, syncDate);
    await writeRidingsSheet(sheets, ridingsData);
  } catch (err) {
    console.warn(`[ridings] Skipped — ${err.response?.data?.message || err.message}`);
  }
}

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

  // Enrich charges with address, phone, and referrer_id data
  const enrichedCharges = await Promise.all(
    charges.map(c => enrichChargeAddress(stripe, c))
  );

  const donorMap = await buildDonorMap(enrichedCharges);
  console.log(`[sync] ${donorMap.size} unique donor(s) to process`);

  const chargeCache = new Map(charges.map((c) => [c.id, c]));

  let historicalEmailSet = new Set();
  if (sheets) {
    const allCharges = await fetchAllCharges(stripe, { silent: true });
    historicalEmailSet = await buildHistoricalEmailSet(allCharges, syncDate);
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
        donor.referrerId || '',
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

  // ── Per-referrer Google Sheets ────────────────────────────────────────────
  // Independent of GOOGLE_SHEET_ID / the master admin sheet above — runs
  // whenever HubSpot + Stripe are configured. Fans the day's referred
  // donations (donorRows, which only contains successfully-upserted donors)
  // and referred membership signups out into each referrer's own sheet, and
  // refreshes leaderboard positions. Never throws.
  await referralAttribution.syncReferrerSheetsForDay(syncDate, donorRows);

  if (sheets) {
    await syncRidingsTab(stripe, sheets, syncDate);
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