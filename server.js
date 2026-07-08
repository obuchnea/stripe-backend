require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const axios = require('axios');
const nodemailer = require('nodemailer');
const referralStatsRouter = require('./referral_stats');

const app = express();
app.use(express.json());
app.use(cors({
  origin: ['http://127.0.0.1:5500', 'https://www.leefairclough.ca']
}));
app.use(referralStatsRouter);

// ─── HubSpot helpers ─────────────────────────────────────────────────────────

const hubspotHeaders = () => ({
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
});

/**
 * Search HubSpot for a contact by email.
 * Returns the full contact object { id, properties } or null if not found.
 */
async function findContactByEmail(email) {
  const res = await axios.post(
    'https://api.hubapi.com/crm/v3/objects/contacts/search',
    {
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: 'EQ',
          value: email,
        }],
      }],
      properties: ['email', 'firstname', 'lastname', 'totalindividualdonations', 'referral_link', 'refer_code'],
      limit: 1,
    },
    { headers: hubspotHeaders() }
  );
  return res.data.results[0] || null;
}

/**
 * HubSpot date properties require a Unix timestamp in milliseconds
 * at midnight UTC. An ISO date string alone will be rejected.
 */
function toHubSpotDate(isoDateString) {
  return new Date(isoDateString + 'T00:00:00.000Z').getTime();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('Server is running');
});

/**
 * Create Payment Intent
 *
 * Accepts { amount, currency, email } from the frontend.
 * Email is stored in Stripe metadata so payment history is queryable by donor.
 */
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, email, ref } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const trimmedEmail = typeof email === 'string' ? email.trim() : '';
    const isValidEmail = emailRegex.test(trimmedEmail);

    const intentParams = {
      amount,
      currency: currency || 'cad',
      automatic_payment_methods: { enabled: false },
      payment_method_types: ["card"],
      metadata: {
        email: trimmedEmail,
        referrer_id: ref || '',
      },
    };

    if (isValidEmail) {
      intentParams.receipt_email = trimmedEmail;
    }

    const paymentIntent = await stripe.paymentIntents.create(intentParams);
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('Create payment intent error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Handle successful donation + HubSpot sync
 *
 * Called by the frontend after Stripe confirms payment.
 * Verifies the payment server-side, then upserts the HubSpot contact:
 *   - Increments totalindividualdonations (running lifetime total)
 *   - Sets latest_donation_date
 *   - Sets is_donor = true
 *
 * The three calculated properties (amount_left_to_donate,
 * donation_limit_reached, donation_compliance_status) update automatically
 * in HubSpot the moment totalindividualdonations changes — no code needed.
 */


app.post('/donation-complete', async (req, res) => {
  try {
    const { email, firstName, lastName, amount, paymentIntentId } = req.body;

    if (!email || !paymentIntentId || !amount) {
      return res.status(400).json({ error: 'Missing required fields: email, paymentIntentId, amount' });
    }

    // 1. Verify payment actually succeeded with Stripe (never trust the client alone)
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }

    // Amount arrives in cents from Stripe; convert to dollars
    const donationAmount = parseFloat((amount / 100).toFixed(2));
    const donationDate = toHubSpotDate(new Date().toISOString().split('T')[0]);

    // 2. Look up existing HubSpot contact by email
    const existing = await findContactByEmail(email);

    if (existing) {
      // 3a. Contact exists — increment their running total
      const currentTotal = parseFloat(existing.properties.totalindividualdonations || 0);
      const newTotal = parseFloat((currentTotal + donationAmount).toFixed(2));

      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${existing.id}`,
        {
          properties: {
            firstname: firstName,
            lastname: lastName,
            totalindividualdonations: newTotal,
            last_donation_amount: donationAmount,
            latest_donation_date: donationDate,
            is_donor: true,
          },
        },
        { headers: hubspotHeaders() }
      );

      console.log(`Updated contact ${existing.id} (${email}): total now $${newTotal}`);
    } else {
      // 3b. New donor — create contact, first donation = total
      await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        {
          properties: {
            email,
            firstname: firstName,
            lastname: lastName,
            totalindividualdonations: donationAmount,
            last_donation_amount: donationAmount,
            latest_donation_date: donationDate,
            is_donor: true,
          },
        },
        { headers: hubspotHeaders() }
      );

      console.log(`Created new contact (${email}): first donation $${donationAmount}`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Donation complete error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── Referral link helpers ──────────────────────────────────────────────────

function slugifyName(str = '') {
  return str
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function buildReferralCode(firstname, lastname, contactId) {
  const base = `${slugifyName(firstname)}_${slugifyName(lastname)}`;
  const suffix = contactId.slice(-4);
  return `${base}_${suffix}`;
}

function buildReferralLink(code) {
  return `https://www.leefairclough.ca/member?referred_by_id=${code}`;
}

// findContactByEmail already exists — just add referral_link to the properties array:
// properties: ['email', 'firstname', 'lastname', 'totalindividualdonations', 'referral_link'],

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * Step 1: check if a contact exists and whether they already have a link.
 */
app.post('/api/referral/lookup', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const contact = await findContactByEmail(email.trim().toLowerCase());

    if (!contact) {
      return res.json({ exists: false });
    }

    // Already generated — idempotent return, no HubSpot write
    if (contact.properties.referral_link && contact.properties.refer_code) {
      return res.json({ exists: true, referralLink: contact.properties.referral_link });
    }

    const referCode = buildReferralCode(
      contact.properties.firstname || '',
      contact.properties.lastname || '',
      contact.id
    );
    const referralLink = buildReferralLink(referCode);

    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`,
      { properties: { referral_link: referralLink, refer_code: referCode } },
      { headers: hubspotHeaders() }
    );

    res.json({ exists: true, referralLink });
  } catch (error) {
    console.error('Referral lookup error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Step 2 (only if lookup returned exists:false): create the contact
 * with the fields collected in-page, then generate the link.
 */
app.post('/api/referral/create', async (req, res) => {
  try {
    const { email, firstName, lastName, phone, postalCode } = req.body;
    if (!email || !firstName || !lastName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const createRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts',
      {
        properties: {
          email: email.trim().toLowerCase(),
          firstname: firstName,
          lastname: lastName,
          phone: phone || '',
          zip: postalCode || '',
        },
      },
      { headers: hubspotHeaders() }
    );

    const contactId = createRes.data.id;
    const referCode = buildReferralCode(firstName, lastName, contactId);
    const referralLink = buildReferralLink(referCode);

    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      { properties: { referral_link: referralLink, refer_code: referCode } },
      { headers: hubspotHeaders() }
    );

    res.json({ referralLink });
  } catch (error) {
    console.error('Referral create error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const cron = require('node-cron');
const { run } = require('./sync');

// Runs every night at 12:01pm EDT (4:01am UTC)
cron.schedule('1 4 * * *', async () => {
  console.log('[cron] Starting nightly sync...');
  await run().catch(err => console.error('[cron] Sync failed:', err.message));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));