/**
 * sync.js — Stripe → HubSpot nightly donor sync
 *
 * Replaces the manual CSV export step from backfill.js.
 * Pulls succeeded charges directly from the Stripe API and upserts
 * HubSpot contacts with up-to-date donation totals.
 *
 * TWO MODES (selected automatically):
 *
 *   Full sync   — no .last_sync file exists (first run).
 *                 Fetches ALL Stripe history and REPLACES totalindividualdonations.
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
 * HOW TO RUN MANUALLY:
 *   node sync.js
 *
 *   Force a full re-sync regardless of .last_sync:
 *   node sync.js --full
 *
 * DEPENDENCIES:
 *   npm install dotenv axios stripe
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const axios  = require('axios');
const Stripe = require('stripe');

// ─── Config ────────────────────────────────────────────────────────────────

const HUBSPOT_BASE  = 'https://api.hubapi.com';
const DELAY_MS      = 150;   // stay under HubSpot's 100 req/10 s rate limit
const LAST_RUN_FILE = path.join(__dirname, '.last_sync');

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
  // Basic format check
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email)) return false;

  // Catch common TLD typos that pass the format check
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

    const amount   = charge.amount / 100; // Stripe stores cents
    const created  = charge.created;      // Unix timestamp
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
 * isFullSync = true  → replace totalindividualdonations (donor map has all-time totals)
 * isFullSync = false → increment totalindividualdonations (donor map has only new charges)
 */
async function upsertContact(email, donor, isFullSync) {
  const { totalAmount, latestCreated, latestAmount, cardName } = donor;
  const { firstname, lastname } = splitName(cardName);
  const hubspotDate = toHubSpotDate(latestCreated);

  const existing = await findContactByEmail(email);
  await sleep(DELAY_MS);

  let newTotal;
  if (isFullSync || !existing) {
    // Full sync or brand-new contact: use the Stripe-computed amount directly
    newTotal = totalAmount;
  } else {
    // Incremental: add new charges on top of what HubSpot already holds
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
    return 'updated';
  } else {
    await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts`,
      { properties: { email, firstname, lastname, ...props } },
      { headers: hubspotHeaders }
    );
    return 'created';
  }
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

  console.log(`[sync] Mode: ${isFullSync ? 'FULL (all-time)' : `INCREMENTAL (since ${new Date(since * 1000).toISOString()})`}`);

  const charges = await fetchCharges(stripe, since);
  console.log(`[sync] ${charges.length} succeeded charge(s) fetched from Stripe`);

  const donorMap = buildDonorMap(charges);
  console.log(`[sync] ${donorMap.size} unique donor(s) to process`);

  if (donorMap.size === 0) {
    console.log('[sync] Nothing to do.');
    saveLastSyncTimestamp(runTimestamp);
    return { created: 0, updated: 0, failed: 0 };
  }

  let created = 0, updated = 0, failed = 0;

  for (const [email, donor] of donorMap) {
    try {
      const result = await upsertContact(email, donor, isFullSync);

      if (result === 'created') {
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
  // On the next run, failed contacts will be retried.
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
  console.log(`────────────────────────────────────────`);

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
