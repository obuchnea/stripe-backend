/**
 * referralAttribution.js — nightly HubSpot queries + leaderboard math for
 * the per-referrer Google Sheets feature (see referralSheets.js).
 *
 * Called once per sync.js run, after the day's Stripe donation processing
 * is done, to:
 *   1. Find new membership signups (HubSpot contacts with referred_by_id
 *      created that day) and append them to the referrer's sheet.
 *   2. Append the day's referred donations (from sync.js's donorRows) into
 *      the referrer's sheet.
 *   3. Recompute both leaderboards (by members_referred_count and by
 *      donations_referred_amount) across ALL referrers, roll last week's
 *      rank forward on the first run of a new ISO week, and push the
 *      updated rank + change into every referrer's sheet.
 *
 * NOT covered: historical backfill. This only processes signups/donations
 * for the specific day sync.js is running for (yesterday, or --date X).
 * Referrers who started referring before this feature shipped won't have
 * their pre-existing history in their sheet — only what happens from here
 * on out.
 *
 * NEW HUBSPOT CONTACT PROPERTIES REQUIRED (create manually — see SETUP.md):
 *   members_referred_count                (number)
 *   member_leaderboard_rank               (number)
 *   member_leaderboard_rank_prev_week     (number)
 *   donation_leaderboard_rank             (number)
 *   donation_leaderboard_rank_prev_week   (number)
 *   leaderboard_week_marker               (single-line text — ISO date of
 *                                           the Monday the "current" rank
 *                                           snapshot belongs to)
 */

const axios = require('axios');
const { DateTime } = require('luxon');
const referralSheets = require('./referralSheets');

const HUBSPOT_BASE = 'https://api.hubapi.com';
const TZ = 'America/Toronto';
const DELAY_MS = 150;

const hubspotHeaders = () => ({
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REFERRER_PROPS = [
  'email', 'firstname', 'lastname', 'refer_code',
  'referral_sheet_id', 'referral_sheet_url',
  'members_referred_count', 'donations_referred_amount',
  'member_leaderboard_rank', 'member_leaderboard_rank_prev_week',
  'donation_leaderboard_rank', 'donation_leaderboard_rank_prev_week',
  'leaderboard_week_marker',
];

/** Every contact that has ever generated a referral link. */
async function fetchAllReferrers() {
  const referrers = [];
  let after;

  do {
    const res = await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      {
        filterGroups: [{ filters: [{ propertyName: 'refer_code', operator: 'HAS_PROPERTY' }] }],
        properties: REFERRER_PROPS,
        limit: 100,
        ...(after ? { after } : {}),
      },
      { headers: hubspotHeaders() }
    );

    referrers.push(...res.data.results);
    after = res.data.paging?.next?.after;
    await sleep(DELAY_MS);
  } while (after);

  return referrers;
}

/** HubSpot contacts created on `dateString` that carry a referred_by_id. */
async function fetchNewMembershipSignups(dateString) {
  const start = DateTime.fromISO(dateString, { zone: TZ }).startOf('day').toMillis();
  const end   = DateTime.fromISO(dateString, { zone: TZ }).endOf('day').toMillis();

  const signups = [];
  let after;

  do {
    const res = await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      {
        filterGroups: [{
          filters: [
            { propertyName: 'membership_signup_date', operator: 'GTE', value: start },
            { propertyName: 'membership_signup_date', operator: 'LTE', value: end },
            { propertyName: 'referred_by_id', operator: 'HAS_PROPERTY' },
          ],
        }],
        properties: ['email', 'firstname', 'lastname', 'zip', 'referred_by_id', 'membership_signup_date'],
        limit: 100,
        ...(after ? { after } : {}),
      },
      { headers: hubspotHeaders() }
    );

    signups.push(...res.data.results);
    after = res.data.paging?.next?.after;
    await sleep(DELAY_MS);
  } while (after);

  return signups;
}

async function incrementMembersReferredCount(referrer, byCount) {
  const current = parseInt(referrer.properties.members_referred_count || 0, 10);
  const next = current + byCount;
  await axios.patch(
    `${HUBSPOT_BASE}/crm/v3/objects/contacts/${referrer.id}`,
    { properties: { members_referred_count: next } },
    { headers: hubspotHeaders() }
  );
  referrer.properties.members_referred_count = next;
}

/** Step 1: sync the day's new membership signups into referrer sheets. */
async function syncMembershipReferrals(dateString, referrerByCode) {
  const signups = await fetchNewMembershipSignups(dateString);
  if (signups.length === 0) return;

  console.log(`[referrals] ${signups.length} new membership signup(s) with a referrer on ${dateString}`);

  const countsByCode = new Map();

  for (const signup of signups) {
    const code = signup.properties.referred_by_id;
    const referrer = referrerByCode.get(code);

    if (!referrer) {
      console.warn(`[referrals] signup ${signup.properties.email} references unknown refer_code "${code}" — skipping`);
      continue;
    }
    if (!referrer.properties.referral_sheet_id) {
      console.warn(`[referrals] referrer ${referrer.properties.email} has no sheet yet — skipping row`);
      continue;
    }

    const when = DateTime.fromMillis(Number(signup.properties.membership_signup_date), { zone: TZ }).toFormat('yyyy-MM-dd HH:mm');
    const name = [signup.properties.firstname, signup.properties.lastname].filter(Boolean).join(' ');

    try {
      await referralSheets.appendMembershipRow(referrer.properties.referral_sheet_id, [
        when, name, signup.properties.email, signup.properties.zip || '',
      ]);
    } catch (err) {
      console.error(`[referrals] Failed to append membership row for ${referrer.properties.email}: ${err.message}`);
      continue;
    }

    countsByCode.set(code, (countsByCode.get(code) || 0) + 1);
    await sleep(DELAY_MS);
  }

  for (const [code, count] of countsByCode) {
    try {
      await incrementMembersReferredCount(referrerByCode.get(code), count);
    } catch (err) {
      console.error(`[referrals] Failed to update members_referred_count for refer_code ${code}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
}

/**
 * Step 2: append the day's referred donations into each referrer's sheet.
 * `donorRows` is the exact array sync.js already builds for its master
 * Donors tab: [date, email, firstname, lastname, amount, chargeId, phone,
 * address, referrerId].
 */
async function syncDonationReferrals(donorRows, referrerByCode, getDonorRiding) {
  const rowsWithReferrer = donorRows.filter(r => r[8]);
  if (rowsWithReferrer.length === 0) return;

  console.log(`[referrals] ${rowsWithReferrer.length} referred donation(s) to sync into referrer sheets`);

  for (const row of rowsWithReferrer) {
    const dateStr   = row[0];
    const email     = row[1];
    const firstname = row[2];
    const lastname  = row[3];
    const amount    = row[4];
    const referCode = row[8];

    const referrer = referrerByCode.get(referCode);
    if (!referrer || !referrer.properties.referral_sheet_id) continue;

    const riding = await getDonorRiding(email);
    const name = [firstname, lastname].filter(Boolean).join(' ');

    try {
      await referralSheets.appendDonationRow(referrer.properties.referral_sheet_id, [
        dateStr, name, email, riding || '', amount,
      ]);
    } catch (err) {
      console.error(`[referrals] Failed to append donation row for ${referrer.properties.email}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
}

/**
 * Step 3: recompute both leaderboards, roll last week's rank forward on the
 * first run of a new ISO week, patch HubSpot, and push updated stats into
 * every referrer's sheet.
 */
async function updateLeaderboardsAndStats(referrers) {
  // Luxon's startOf('week') is always ISO-8601 (Monday), regardless of locale.
  const currentMonday = DateTime.now().setZone(TZ).startOf('week').toFormat('yyyy-MM-dd');

  const byMembers = [...referrers].sort((a, b) =>
    parseInt(b.properties.members_referred_count || 0, 10) - parseInt(a.properties.members_referred_count || 0, 10)
  );
  const byDonations = [...referrers].sort((a, b) =>
    parseFloat(b.properties.donations_referred_amount || 0) - parseFloat(a.properties.donations_referred_amount || 0)
  );

  const memberRankOf   = new Map(byMembers.map((r, i) => [r.id, i + 1]));
  const donationRankOf = new Map(byDonations.map((r, i) => [r.id, i + 1]));

  for (const referrer of referrers) {
    const isNewWeek = referrer.properties.leaderboard_week_marker !== currentMonday;

    // On the first run of a new week, this week's outgoing "current" rank
    // becomes next week's "previous" baseline. Otherwise keep whatever
    // previous-week baseline is already stored.
    const prevMemberRank = isNewWeek
      ? (parseInt(referrer.properties.member_leaderboard_rank, 10) || null)
      : (parseInt(referrer.properties.member_leaderboard_rank_prev_week, 10) || null);
    const prevDonationRank = isNewWeek
      ? (parseInt(referrer.properties.donation_leaderboard_rank, 10) || null)
      : (parseInt(referrer.properties.donation_leaderboard_rank_prev_week, 10) || null);

    const newMemberRank   = memberRankOf.get(referrer.id);
    const newDonationRank = donationRankOf.get(referrer.id);

    try {
      await axios.patch(
        `${HUBSPOT_BASE}/crm/v3/objects/contacts/${referrer.id}`,
        { properties: {
            member_leaderboard_rank: newMemberRank,
            member_leaderboard_rank_prev_week: prevMemberRank,
            donation_leaderboard_rank: newDonationRank,
            donation_leaderboard_rank_prev_week: prevDonationRank,
            leaderboard_week_marker: currentMonday,
        }},
        { headers: hubspotHeaders() }
      );
    } catch (err) {
      console.error(`[referrals] Failed to patch leaderboard ranks for ${referrer.properties.email}: ${err.message}`);
      continue;
    }
    await sleep(DELAY_MS);

    if (!referrer.properties.referral_sheet_id) continue;

    try {
      await referralSheets.updateMembershipStats(referrer.properties.referral_sheet_id, {
        rank: newMemberRank, rankPrev: prevMemberRank,
      });
      await referralSheets.updateDonationStats(referrer.properties.referral_sheet_id, {
        rank: newDonationRank, rankPrev: prevDonationRank,
      });
    } catch (err) {
      console.error(`[referrals] Failed to update sheet stats for ${referrer.properties.email}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
}

/**
 * Entry point, called from sync.js's run() after the day's donations have
 * been processed. Wrapped so a failure here never takes down the core
 * Stripe → HubSpot → master-sheet sync.
 */
async function syncReferrerSheetsForDay(dateString, donorRows) {
  try {
    const referrers = await fetchAllReferrers();
    if (referrers.length === 0) return;

    const referrerByCode = new Map(referrers.map(r => [r.properties.refer_code, r]));
    const contactCache = new Map(); // donor email -> riding (zip), memoized per run

    async function getDonorRiding(email) {
      if (contactCache.has(email)) return contactCache.get(email);
      try {
        const res = await axios.post(
          `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
          {
            filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
            properties: ['zip'],
            limit: 1,
          },
          { headers: hubspotHeaders() }
        );
        const zip = res.data.results[0]?.properties?.zip || '';
        contactCache.set(email, zip);
        await sleep(DELAY_MS);
        return zip;
      } catch (_) {
        return '';
      }
    }

    await syncMembershipReferrals(dateString, referrerByCode);
    await syncDonationReferrals(donorRows, referrerByCode, getDonorRiding);

    // Re-fetch so the leaderboard pass sees any members_referred_count
    // bumps made in syncMembershipReferrals() above.
    const refreshed = await fetchAllReferrers();
    await updateLeaderboardsAndStats(refreshed);
  } catch (err) {
    console.error('[referrals] syncReferrerSheetsForDay failed (core sync unaffected):', err.response?.data || err.message);
  }
}

module.exports = { syncReferrerSheetsForDay };