/**
 * referralStats.js
 *
 * Admin-only endpoints powering the referral stats dashboard for leadership.
 * Mount this router in server.js:
 *
 *   const referralStatsRouter = require('./referralStats');
 *   app.use(referralStatsRouter);
 *
 * Requires an ADMIN_SECRET env var. The dashboard sends it as the
 * `x-admin-secret` header on every request.
 *
 * ── IMPORTANT: property names ──────────────────────────────────────────────
 * This assumes the following HubSpot contact property internal names.
 * Double check these against your actual portal (Settings > Properties)
 * and adjust the PROPS map below if any differ:
 *
 *   referred_by_id            - set via the hidden-field/URL-param capture
 *   refer_code                - a contact's own referral code (if they are a referrer)
 *   riding                    - set by update_riding.js
 *   zip                       - postal code, set by update_postal.js / form
 *   city, state               - standard HubSpot contact properties
 *   totalindividualdonations  - running lifetime donation total
 *   latest_donation_date      - most recent donation date
 *   createdate                - standard HubSpot "date created" property
 */

const express = require('express');
const axios = require('axios');

const router = express.Router();

const PROPS = {
  referredBy: 'referred_by_id',
  referCode: 'refer_code',
  riding: 'riding',
  zip: 'zip',
  city: 'city',
  province: 'state',
  donationTotal: 'totalindividualdonations',
  lastDonation: 'latest_donation_date',
};

const hubspotHeaders = () => ({
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
});

function toHubSpotDate(isoDateString) {
  return new Date(isoDateString + 'T00:00:00.000Z').getTime();
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET) {
    console.error('ADMIN_SECRET is not set on the server');
    return res.status(500).json({ error: 'Server misconfigured: ADMIN_SECRET not set' });
  }
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── HubSpot helper: paginate a contacts search to completion ──────────────

async function searchAllContacts(filterGroups, properties) {
  const results = [];
  let after;

  do {
    const body = {
      filterGroups,
      properties,
      limit: 100,
      ...(after ? { after } : {}),
    };

    const res = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
      body,
      { headers: hubspotHeaders() }
    );

    results.push(...res.data.results);
    after = res.data.paging?.next?.after;

    // Safety valve so a bad filter can't loop forever
    if (results.length > 20000) break;
  } while (after);

  return results;
}

// ─── GET /api/admin/referrers ───────────────────────────────────────────────
// Returns everyone who has a refer_code, for the "filter by user" picker.

router.get('/api/admin/referrers', requireAdmin, async (req, res) => {
  try {
    const filterGroups = [{
      filters: [{ propertyName: PROPS.referCode, operator: 'HAS_PROPERTY' }],
    }];
    const properties = ['email', 'firstname', 'lastname', PROPS.referCode];

    const contacts = await searchAllContacts(filterGroups, properties);

    const referrers = contacts.map(c => ({
      id: c.id,
      code: c.properties[PROPS.referCode],
      name: `${c.properties.firstname || ''} ${c.properties.lastname || ''}`.trim() || '(no name)',
      email: c.properties.email || '',
    }));

    res.json({ referrers });
  } catch (error) {
    console.error('List referrers error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/admin/referral-stats ─────────────────────────────────────────
// Returns raw, row-level referral data for the given referrer/date filters.
// Geography filtering and all aggregation/charting happens client-side so
// leadership can re-slice the data without round-tripping to the server.
//
// Body: { startDate?: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD', referrerCodes?: string[] }

router.post('/api/admin/referral-stats', requireAdmin, async (req, res) => {
  try {
    const { startDate, endDate, referrerCodes } = req.body || {};

    const filters = [
      { propertyName: PROPS.referredBy, operator: 'HAS_PROPERTY' },
    ];

    if (startDate) {
      filters.push({
        propertyName: 'createdate',
        operator: 'GTE',
        value: toHubSpotDate(startDate),
      });
    }

    if (endDate) {
      // make end date inclusive (through 23:59:59.999 of that day)
      const endTs = toHubSpotDate(endDate) + 24 * 60 * 60 * 1000 - 1;
      filters.push({
        propertyName: 'createdate',
        operator: 'LTE',
        value: endTs,
      });
    }

    if (Array.isArray(referrerCodes) && referrerCodes.length > 0) {
      filters.push({
        propertyName: PROPS.referredBy,
        operator: 'IN',
        values: referrerCodes,
      });
    }

    const properties = [
      'email', 'firstname', 'lastname', 'createdate',
      PROPS.referredBy, PROPS.riding, PROPS.zip, PROPS.city, PROPS.province,
      PROPS.donationTotal, PROPS.lastDonation,
    ];

    const contacts = await searchAllContacts([{ filters }], properties);

    const rows = contacts.map(c => {
      const p = c.properties;
      const rawZip = (p[PROPS.zip] || '').replace(/\s/g, '').toUpperCase();

      return {
        id: c.id,
        email: p.email || '',
        name: `${p.firstname || ''} ${p.lastname || ''}`.trim() || '(no name)',
        referredByCode: p[PROPS.referredBy] || '',
        createdAt: p.createdate || null,
        donationTotal: parseFloat(p[PROPS.donationTotal] || 0),
        lastDonationDate: p[PROPS.lastDonation] || null,
        riding: p[PROPS.riding] || '',
        postalCode: rawZip,
        fsa: rawZip.slice(0, 3),
        city: p[PROPS.city] || '',
        province: p[PROPS.province] || '',
      };
    });

    res.json({ rows, count: rows.length });
  } catch (error) {
    console.error('Referral stats error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;