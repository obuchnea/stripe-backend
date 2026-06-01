/**
 * backfill.js — One-time script to sync all Stripe donors into HubSpot
 *
 * SOURCE OF TRUTH: unified_payments.csv exported from Stripe Dashboard
 *
 * LOGIC:
 *   For each donor found in Stripe:
 *
 *   - Contact NOT in HubSpot at all → CREATE with full donation data
 *
 *   - Contact IS in HubSpot, no totalindividualdonations set → UPDATE
 *     (they were missed in the manual port)
 *
 *   - Contact IS in HubSpot, has a value, donated only ONCE in Stripe → SKIP
 *     (their value was already correctly ported; don't touch it)
 *
 *   - Contact IS in HubSpot, has a value, donated MORE THAN ONCE in Stripe → UPDATE
 *     (their HubSpot value likely only reflects one donation; fix the total)
 *
 * NOTE ON CALCULATED PROPERTIES:
 *   amount_left_to_donate, donation_limit_reached, and donation_compliance_status
 *   are HubSpot formula properties. They update automatically when
 *   totalindividualdonations changes. This script never writes to them.
 *
 * HOW TO RUN:
 *   1. Place unified_payments.csv in the same folder as this script
 *   2. Ensure .env has HUBSPOT_ACCESS_TOKEN set
 *   3. npm install dotenv axios papaparse   (if not already installed)
 *   4. node backfill.js
 *
 *   To use a different CSV path: node backfill.js /path/to/file.csv
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Papa = require('papaparse');

const HUBSPOT_BASE = 'https://api.hubapi.com';
const DELAY_MS = 150; // stay under HubSpot's 100 req/10s rate limit

const headers = {
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HubSpot date properties require a Unix timestamp in milliseconds
 * at midnight UTC. e.g. "2026-05-18 01:05:47" → 1747526400000
 */
function toHubSpotDate(stripeDateTime) {
  const dateOnly = stripeDateTime.split(' ')[0]; // "2026-05-18"
  return new Date(dateOnly + 'T00:00:00.000Z').getTime();
}

/**
 * Split a full name (e.g. "Robert J Rushby") into firstname + lastname.
 * Everything after the first word becomes the lastname.
 */
function splitName(fullName) {
  if (!fullName || !fullName.trim()) return { firstname: '', lastname: '' };
  const parts = fullName.trim().split(/\s+/);
  return {
    firstname: parts[0],
    lastname: parts.slice(1).join(' '),
  };
}

/**
 * Search HubSpot for a contact by email.
 * Returns { id, properties } or null.
 */
async function findContactByEmail(email) {
  const res = await axios.post(
    `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
    {
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: 'EQ',
          value: email,
        }],
      }],
      properties: ['email', 'firstname', 'lastname', 'totalindividualdonations'],
      limit: 1,
    },
    { headers }
  );
  return res.data.results[0] || null;
}

/**
 * Read and parse the Stripe CSV export.
 */
function parseCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const result = Papa.parse(raw, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });
  if (result.errors.length > 0) {
    console.warn('CSV parse warnings:', result.errors.slice(0, 3));
  }
  return result.data;
}

/**
 * Group paid rows by email.
 * Returns a Map: email → { totalAmount, donationCount, latestDate, cardName }
 */
function buildDonorMap(rows) {
  const donors = new Map();

  for (const row of rows) {
    if (String(row['Status']).toLowerCase() !== 'paid') continue;

    const email = (row['Customer Email'] || '').trim().toLowerCase();
    if (!email) continue;

    const amount = parseFloat(row['Amount']) || 0;
    const dateStr = String(row['Created date (UTC)'] || '');
    const cardName = String(row['Card Name'] || '').trim();

    if (donors.has(email)) {
      const existing = donors.get(email);
      existing.totalAmount = parseFloat((existing.totalAmount + amount).toFixed(2));
      existing.donationCount += 1;
      if (dateStr > existing.latestDate) {
        existing.latestDate = dateStr;
        existing.latestAmount = amount; // amount from the most recent donation
      }
    } else {
      donors.set(email, {
        totalAmount: amount,
        donationCount: 1,
        latestDate: dateStr,
        latestAmount: amount,
        cardName,
      });
    }
  }

  return donors;
}

async function run() {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    console.error('ERROR: HUBSPOT_ACCESS_TOKEN is not set in your .env file.');
    process.exit(1);
  }

  const csvPath = process.argv[2] || path.join(__dirname, 'unified_payments.csv');

  if (!fs.existsSync(csvPath)) {
    console.error(`ERROR: CSV file not found at: ${csvPath}`);
    console.error('Usage: node backfill.js [path/to/payments.csv]');
    process.exit(1);
  }

  console.log(`Reading CSV: ${csvPath}`);
  const rows = parseCSV(csvPath);
  console.log(`Total rows in CSV: ${rows.length}`);

  const donorMap = buildDonorMap(rows);
  console.log(`Unique donors with successful payments: ${donorMap.size}`);
  console.log('\nStarting HubSpot sync...\n');

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const [email, donor] of donorMap) {
    const { totalAmount, donationCount, latestDate, latestAmount, cardName } = donor;
    const { firstname, lastname } = splitName(cardName);
    const hubspotDate = toHubSpotDate(latestDate);

    try {
      const existing = await findContactByEmail(email);
      await sleep(DELAY_MS);

      if (existing) {
        const currentTotal = parseFloat(existing.properties.totalindividualdonations || 0);

        if (currentTotal > 0 && donationCount === 1) {
          // Already correctly ported as a single donation — leave it alone
          console.log(`  - SKIPPED  ${email} — already has $${currentTotal}, single donation`);
          skipped++;
        } else {
          // Either missing a value, or a repeat donor whose total needs correcting
          const reason = currentTotal === 0 ? 'missing value' : `repeat donor (${donationCount} donations)`;
          await axios.patch(
            `${HUBSPOT_BASE}/crm/v3/objects/contacts/${existing.id}`,
            {
              properties: {
                totalindividualdonations: totalAmount,
                last_donation_amount: latestAmount,
                latest_donation_date: hubspotDate,
                is_donor: true,
              },
            },
            { headers }
          );
          console.log(`  ✓ UPDATED  ${email} — $${totalAmount} (${reason})`);
          updated++;
        }
      } else {
        // Not in HubSpot at all — create them
        await axios.post(
          `${HUBSPOT_BASE}/crm/v3/objects/contacts`,
          {
            properties: {
              email,
              firstname,
              lastname,
              totalindividualdonations: totalAmount,
              last_donation_amount: latestAmount,
              latest_donation_date: hubspotDate,
              is_donor: true,
            },
          },
          { headers }
        );
        console.log(`  ✓ CREATED  ${email} — $${totalAmount}`);
        created++;
      }
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message;
      console.error(`  ✗ FAILED   ${email} — ${errMsg}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(`Backfill complete.`);
  console.log(`  Created:  ${created}`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  Skipped:  ${skipped}  (already correct, single donation)`);
  console.log(`  Failed:   ${failed}`);
  console.log(`────────────────────────────────────────`);

  if (failed > 0) {
    console.log('\nSome contacts failed. Re-run the script — it is safe to run multiple times.');
  }
}

run().catch((err) => {
  console.error('Fatal error:', err.response?.data || err.message);
  process.exit(1);
});