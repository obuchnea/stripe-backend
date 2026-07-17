/**
 * referralSheets.js — Per-referrer Google Sheet creation, sharing, and
 * nightly row/stat updates.
 *
 * Each referrer gets their own spreadsheet, created the first time they
 * successfully generate a referral link, with two tabs:
 *   - "Membership Referrals"
 *   - "Donation Referrals"
 *
 * Both tabs have a data table (appended to nightly) and a small stats
 * block off to the side (overwritten in place nightly, never appended to).
 *
 * REQUIRES:
 *   - Drive API enabled on the same Google Cloud project as the Sheets API
 *   - A Google Workspace Shared Drive that the service account (the
 *     `client_email` inside GOOGLE_SERVICE_ACCOUNT_JSON) has been added to
 *     as a Content Manager. Plain service accounts have 0 bytes of personal
 *     Drive storage and CANNOT create files outside of a Shared Drive —
 *     see SETUP.md.
 *   - GOOGLE_SHARED_DRIVE_ID env var — the Shared Drive's ID, found in its
 *     URL: https://drive.google.com/drive/folders/<THIS PART>
 *
 * NEW HUBSPOT CONTACT PROPERTIES THIS FEATURE RELIES ON (create manually
 * first — see SETUP.md):
 *   referral_sheet_id       (single-line text)
 *   referral_sheet_url      (single-line text)
 */

require('dotenv').config();
const { google } = require('googleapis');
const { DateTime } = require('luxon');

const TZ = 'America/Toronto';

const MEMBERSHIP_TAB = 'Membership Referrals';
const DONATION_TAB   = 'Donation Referrals';

let _sheetsClient = null;
let _driveClient  = null;

async function getClients() {
  if (_sheetsClient && _driveClient) return { sheets: _sheetsClient, drive: _driveClient };

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');

  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  _sheetsClient = google.sheets({ version: 'v4', auth });
  _driveClient  = google.drive({ version: 'v3', auth });
  return { sheets: _sheetsClient, drive: _driveClient };
}

/**
 * Create a brand-new per-referrer spreadsheet with both tabs pre-formatted,
 * share it with the referrer's email only, and return { sheetId, sheetUrl }.
 */
async function createReferrerSheet({ email, firstName, lastName }) {
  const { sheets, drive } = await getClients();
  const sharedDriveId = process.env.GOOGLE_SHARED_DRIVE_ID;
  if (!sharedDriveId) throw new Error('GOOGLE_SHARED_DRIVE_ID is not set — see SETUP.md');

  const title = `Referral Stats — ${firstName} ${lastName} (${email})`;

  // 1. Create the spreadsheet file directly inside the Shared Drive.
  //    (A bare service account has no personal quota — see module header.)
  const createRes = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [sharedDriveId],
    },
    supportsAllDrives: true,
    fields: 'id',
  });
  const sheetId = createRes.data.id;

  // 2. Rename the default "Sheet1" and add the second tab.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const firstTabId = meta.data.sheets[0].properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        { updateSheetProperties: {
            properties: { sheetId: firstTabId, title: MEMBERSHIP_TAB },
            fields: 'title',
        }},
        { addSheet: { properties: { title: DONATION_TAB } } },
      ],
    },
  });

  // 3. Write headers + stat labels on both tabs.
  await writeSheetTemplate(sheets, sheetId);

  // 4. Share with the referrer only — reader access, since the sheet is a
  //    live report that nightly sync appends to by row position. Bump to
  //    'writer' if you'd rather they be able to sort/filter it directly.
  await drive.permissions.create({
    fileId: sheetId,
    supportsAllDrives: true,
    sendNotificationEmail: true,
    requestBody: { type: 'user', role: 'reader', emailAddress: email },
  });

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  return { sheetId, sheetUrl };
}

async function writeSheetTemplate(sheets, sheetId) {
  const data = [
    // Membership tab: data cols A-D, stat labels col F, stat values col G
    { range: `${MEMBERSHIP_TAB}!A1:D1`, values: [[
      'Date & Time of Signup', 'Name', 'Email', 'Riding',
    ]]},
    { range: `${MEMBERSHIP_TAB}!F1:G1`, values: [['Stat', 'Value']] },
    { range: `${MEMBERSHIP_TAB}!F2:F6`, values: [
      ['Total Referrals'], ['Referrals (Past Month)'], ['Referrals (Past Week)'],
      ['Leaderboard Position'], ['Position Change (vs Last Week)'],
    ]},
    // Donation tab: data cols A-E, stat labels col G, stat values col H
    { range: `${DONATION_TAB}!A1:E1`, values: [[
      'Date & Time of Donation', 'Donor Name', 'Donor Email', 'Riding', 'Amount ($)',
    ]]},
    { range: `${DONATION_TAB}!G1:H1`, values: [['Stat', 'Value']] },
    { range: `${DONATION_TAB}!G2:G6`, values: [
      ['Total Referred Donations ($)'], ['Referred Donations (Past Month) ($)'],
      ['Referred Donations (Past Week) ($)'], ['Leaderboard Position'],
      ['Position Change (vs Last Week)'],
    ]},
  ];

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });

  // Bold both header rows.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const boldRequests = meta.data.sheets.map(s => ({
    repeatCell: {
      range: { sheetId: s.properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: boldRequests } });
}

/** Append one membership-referral row: [datetime, name, email, riding]. */
async function appendMembershipRow(sheetId, row) {
  const { sheets } = await getClients();
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${MEMBERSHIP_TAB}!A:D`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

/** Append one donation-referral row: [datetime, donor name, donor email, riding, amount]. */
async function appendDonationRow(sheetId, row) {
  const { sheets } = await getClients();
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${DONATION_TAB}!A:E`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

async function readDataRows(sheetId, tab, colRange) {
  const { sheets } = await getClients();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tab}!${colRange}`,
  });
  const rows = res.data.values || [];
  return rows.slice(1); // drop header row
}

function countSince(rows, dateColIndex, sinceDate, dateFormat) {
  return rows.filter(r => {
    const d = DateTime.fromFormat(r[dateColIndex] || '', dateFormat, { zone: TZ });
    return d.isValid && d >= sinceDate;
  }).length;
}

function sumSince(rows, dateColIndex, amountColIndex, sinceDate, dateFormat) {
  return rows
    .filter(r => {
      const d = DateTime.fromFormat(r[dateColIndex] || '', dateFormat, { zone: TZ });
      return d.isValid && d >= sinceDate;
    })
    .reduce((sum, r) => sum + (parseFloat(r[amountColIndex]) || 0), 0);
}

/**
 * Recompute total/month/week counts from the tab's own data (ground truth,
 * rather than a separately-tracked counter that could drift), and write
 * them alongside the leaderboard rank + week-over-week change.
 */
async function updateStatsBlock(sheetId, tab, { statsRange, dataRange, dateColIndex, dateFormat, amountColIndex, rank, rankPrev }) {
  const { sheets } = await getClients();
  const rows = await readDataRows(sheetId, tab, dataRange);

  const now      = DateTime.now().setZone(TZ);
  const monthAgo = now.minus({ months: 1 });
  const weekAgo  = now.minus({ weeks: 1 });

  let total, pastMonth, pastWeek;
  if (amountColIndex != null) {
    total     = rows.reduce((sum, r) => sum + (parseFloat(r[amountColIndex]) || 0), 0);
    pastMonth = sumSince(rows, dateColIndex, amountColIndex, monthAgo, dateFormat);
    pastWeek  = sumSince(rows, dateColIndex, amountColIndex, weekAgo, dateFormat);
  } else {
    total     = rows.length;
    pastMonth = countSince(rows, dateColIndex, monthAgo, dateFormat);
    pastWeek  = countSince(rows, dateColIndex, weekAgo, dateFormat);
  }

  const rankDelta = (rankPrev != null && rank != null) ? (rankPrev - rank) : '';

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tab}!${statsRange}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[total], [pastMonth], [pastWeek], [rank ?? ''], [rankDelta]] },
  });
}

async function updateMembershipStats(sheetId, { rank, rankPrev }) {
  await updateStatsBlock(sheetId, MEMBERSHIP_TAB, {
    statsRange: 'G2:G6', dataRange: 'A2:A', dateColIndex: 0,
    dateFormat: 'yyyy-MM-dd HH:mm', rank, rankPrev,
  });
}

async function updateDonationStats(sheetId, { rank, rankPrev }) {
  await updateStatsBlock(sheetId, DONATION_TAB, {
    statsRange: 'H2:H6', dataRange: 'A2:E', dateColIndex: 0,
    dateFormat: 'yyyy-MM-dd', amountColIndex: 4, rank, rankPrev,
  });
}

module.exports = {
  createReferrerSheet,
  appendMembershipRow,
  appendDonationRow,
  updateMembershipStats,
  updateDonationStats,
};