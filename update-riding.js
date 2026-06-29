/**
 * update_riding.js
 *
 * For each HubSpot contact that has a postal code (property: "zip"),
 * looks up the Ontario riding from the lookup CSV and writes it to
 * the "riding" contact property.
 *
 * Usage:
 *   1. npm install axios csv-parse
 *   2. Set your HubSpot private app token below (or via env var)
 *   3. Place postal_to_riding.csv in the same folder as this script
 *   4. node update_riding.js
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
require("dotenv").config();

// ─── CONFIG ────────────────────────────────────────────────────────────────

const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

const LOOKUP_FILE = path.join(__dirname, "postal_to_riding.csv");

// HubSpot internal property names
const POSTAL_PROP = "zip";
const RIDING_PROP = "riding";
const CITY_PROP = "city";

// How many contacts to update per HubSpot API batch (max 100)
const BATCH_SIZE = 100;

// How many contacts to fetch per page (max 100)
const PAGE_SIZE = 100;

// Milliseconds to wait between batch updates (avoid rate limits)
const RATE_LIMIT_DELAY_MS = 200;

// ─── HELPERS ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizePostal(raw) {
  // Uppercase, collapse whitespace, ensure "A1A 1A1" format
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

// Canadian postal code pattern: Letter-Digit-Letter SPACE Digit-Letter-Digit
const POSTAL_CODE_REGEX = /^[A-Za-z]\d[A-Za-z]\s\d[A-Za-z]\d$/;

/**
 * Validates a postal code against the standard "A1A 1A1" format.
 * If it doesn't match, strips all whitespace, uppercases every
 * character, and re-inserts a single space after the 3rd character.
 *
 * Returns:
 *   { formatted: "A1A 1A1", changed: true|false }  on success
 *   null  if the value can't be parsed into a valid 6-character
 *         Canadian postal code even after cleanup
 */
function formatPostalCode(raw) {
  if (!raw) return null;

  const original = raw.trim();

  // Already correctly formatted
  if (POSTAL_CODE_REGEX.test(original)) {
    return { formatted: original.toUpperCase(), changed: false };
  }

  // Strip all whitespace, uppercase everything, then validate shape
  const stripped = original.replace(/\s+/g, "").toUpperCase();

  if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(stripped)) {
    return null; // not a parseable Canadian postal code
  }

  const formatted = `${stripped.slice(0, 3)} ${stripped.slice(3)}`;
  return { formatted, changed: true };
}

// ─── LOAD LOOKUP TABLE ─────────────────────────────────────────────────────

function loadLookup(filePath) {
  console.log(`Loading lookup table from ${filePath}...`);
  const content = fs.readFileSync(filePath, "utf8");
  const records = parse(content, { columns: true, skip_empty_lines: true });

  const map = new Map();
  for (const row of records) {
    if (row.riding_name_en) {
      map.set(normalizePostal(row.postal_code), {
        riding: row.riding_name_en,
        city: row.city || null,
      });
    }
  }
  console.log(`  Loaded ${map.size} postal codes.\n`);
  return map;
}

// ─── HUBSPOT API ───────────────────────────────────────────────────────────

const hubspot = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  },
});

/**
 * Fetch all contacts that have a non-empty postal code property.
 * Returns array of { id, zip } objects.
 */
async function fetchContacts() {
  console.log("Fetching contacts from HubSpot...");
  const contacts = [];
  let after = undefined;

  while (true) {
    const params = {
      limit: PAGE_SIZE,
      properties: [POSTAL_PROP, RIDING_PROP, CITY_PROP].join(','),
    };
    if (after) params.after = after;

    const res = await hubspot.get("/crm/v3/objects/contacts", { params });
    const { results, paging } = res.data;

    for (const contact of results) {
      const zip = contact.properties[POSTAL_PROP];
      if (zip && zip.trim()) {
        contacts.push({ id: contact.id, zip: zip.trim() });
      }
    }

    process.stdout.write(`  Fetched ${contacts.length} contacts with postal codes so far...\r`);

    if (paging?.next?.after) {
      after = paging.next.after;
    } else {
      break;
    }
  }

  console.log(`\n  Done. Found ${contacts.length} contacts with a postal code.\n`);
  return contacts;
}

/**
 * Send a batch update to HubSpot (up to 100 contacts at a time).
 */
async function batchUpdate(updates) {
  // updates: [{ id, properties: { riding: "..." } }]
  await hubspot.post("/crm/v3/objects/contacts/batch/update", {
    inputs: updates,
  });
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  // 1. Load lookup table
  const lookup = loadLookup(LOOKUP_FILE);

  // 2. Fetch contacts
  const contacts = await fetchContacts();

  // 3. Match each contact to a riding
  const updates = [];
  const stats = { matched: 0, cityMatched: 0, noMatch: 0, skipped: 0, reformatted: 0, unparseable: 0 };

  for (const { id, zip } of contacts) {
    const result = formatPostalCode(zip);

    if (!result) {
      console.warn(`  Could not parse postal code for contact ${id}: "${zip}"`);
      stats.unparseable++;
      continue;
    }

    const { formatted, changed } = result;
    const match = lookup.get(formatted);

    const properties = {};
    if (match) {
      properties[RIDING_PROP] = match.riding;
      stats.matched++;

      if (match.city) {
        properties[CITY_PROP] = match.city;
        stats.cityMatched++;
      }
    } else {
      console.warn(`  No riding found for postal code: "${formatted}"`);
      stats.noMatch++;
    }

    if (changed) {
      properties[POSTAL_PROP] = formatted;
      stats.reformatted++;
    }

    if (Object.keys(properties).length > 0) {
      updates.push({ id, properties });
    }
  }

  console.log(`Matched:      ${stats.matched} contacts (riding)`);
  console.log(`City set:     ${stats.cityMatched} contacts (city)`);
  console.log(`No match:     ${stats.noMatch} contacts (postal code not in lookup)`);
  console.log(`Reformatted:  ${stats.reformatted} contacts (postal code fixed to "A1A 1A1")`);
  console.log(`Unparseable:  ${stats.unparseable} contacts (postal code couldn't be cleaned up)\n`);

  if (updates.length === 0) {
    console.log("Nothing to update.");
    return;
  }

  // 4. Send updates in batches
  console.log(`Updating ${updates.length} contacts in HubSpot...`);
  let done = 0;

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    await batchUpdate(batch);
    done += batch.length;
    process.stdout.write(`  Updated ${done} / ${updates.length}\r`);
    if (i + BATCH_SIZE < updates.length) await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log(`\n\nDone! ${done} contacts updated successfully.`);
}

if (!HUBSPOT_TOKEN) {
  console.error("Error: HUBSPOT_ACCESS_TOKEN is not set in your .env file.");
  process.exit(1);
}

main().catch((err) => {
  console.error("\nError:", err.response?.data ?? err.message);
  process.exit(1);
});