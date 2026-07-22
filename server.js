require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const axios = require('axios');
const nodemailer = require('nodemailer');
const referralStatsRouter = require('./referral_stats');
const referralSheets = require('./referralSheets');

const app = express();
app.use(express.json());
app.use(cors({
  origin: ['http://127.0.0.1:5500', 'https://www.leefairclough.ca']
}));
app.use(referralStatsRouter);

// ─── HubSpot helpers ─────────────────────────────────────────────────────────

let formsCache = { data: null, expiresAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchAllHubSpotForms() {
  const results = [];
  let after = undefined;

  do {
    const url = new URL('https://api.hubapi.com/marketing/v3/forms/');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_FORMS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HubSpot Forms API error ${res.status}: ${errText}`);
    }

    const json = await res.json();
    results.push(...json.results);
    after = json.paging?.next?.after;
  } while (after);

  return results;
}

async function getCachedEventForms() {
  const now = Date.now();
  if (!formsCache.data || now > formsCache.expiresAt) {
    const allForms = await fetchAllHubSpotForms();
    const eventForms = allForms
      .filter(f => f.name.toUpperCase().startsWith('EVENT'))
      .filter(f => !f.archived)
      .map(f => ({ id: f.id, name: f.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    formsCache = { data: eventForms, expiresAt: now + CACHE_TTL_MS };
  }
  return formsCache.data;
}

app.get('/api/event-forms', async (req, res) => {
  try {
    res.json(await getCachedEventForms());
  } catch (err) {
    console.error('Failed to fetch event forms:', err);
    res.status(500).json({ error: 'Could not load event list' });
  }
});

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
      properties: [
        'email', 'firstname', 'lastname', 'totalindividualdonations',
        'referral_link', 'refer_code', 'referred_by_id',
        'referral_sheet_id', 'referral_sheet_url', 'zip',
        'donation_referral_link',
      ],
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

async function attributeDonationReferral(referCode, donationAmount) {
  try {
    const res = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
      {
        filterGroups: [{
          filters: [{ propertyName: 'refer_code', operator: 'EQ', value: referCode }],
        }],
        properties: ['refer_code', 'donations_referred_count', 'donations_referred_amount'],
        limit: 1,
      },
      { headers: hubspotHeaders() }
    );

    const referrer = res.data.results[0];
    if (!referrer) {
      console.warn(`donation referral: no contact found for refer_code "${referCode}"`);
      return;
    }

    const currentCount = parseInt(referrer.properties.donations_referred_count || 0, 10);
    const currentAmount = parseFloat(referrer.properties.donations_referred_amount || 0);

    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${referrer.id}`,
      {
        properties: {
          donations_referred_count: currentCount + 1,
          donations_referred_amount: parseFloat((currentAmount + donationAmount).toFixed(2)),
        },
      },
      { headers: hubspotHeaders() }
    );

    console.log(`Attributed $${donationAmount} donation to referrer ${referrer.id} (${referCode})`);
  } catch (err) {
    console.error('Referral attribution failed:', err.response?.data || err.message);
  }
}

async function patchReferralProperties(contactId, properties) {
  await axios.patch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
    { properties },
    { headers: hubspotHeaders() }
  );
}

// ─── Event attendance helpers ────────────────────────────────────────────────

function stripEventPrefixServer(name) {
  return name.replace(/^event\s*-\s*/i, '').trim();
}

// HubSpot form field internal names → the keys we want in our attendee
// objects. IMPORTANT: verify these against a real submission for your
// actual EVENT forms (see "How to verify field names" below) — if your
// forms use e.g. "mobilephone" instead of "phone", update the key here.
const SUBMISSION_FIELD_MAP = {
  firstname: 'firstName',
  lastname: 'lastName',
  phone: 'phone',
  email: 'email',
  zip: 'postalCode',
};

function parseSubmissionValues(values) {
  const parsed = {};
  for (const { name, value } of values) {
    const key = SUBMISSION_FIELD_MAP[name];
    if (key) parsed[key] = value;
  }
  return parsed;
}

async function fetchFormSubmissions(formId) {
  const results = [];
  let after = undefined;

  do {
    const url = new URL(`https://api.hubapi.com/form-integrations/v1/submissions/forms/${formId}`);
    url.searchParams.set('limit', '50');
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url, { headers: hubspotHeaders() });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HubSpot submissions API error ${res.status}: ${errText}`);
    }

    const json = await res.json();
    results.push(...json.results);
    after = json.paging?.next?.after;
  } while (after);

  return results;
}

// Cached the same way formsCache is — the option list rarely changes.
let eventOptionsCache = { data: null, expiresAt: 0 };

async function getEventsAttendedOptions() {
  const now = Date.now();
  if (!eventOptionsCache.data || now > eventOptionsCache.expiresAt) {
    const res = await axios.get(
      'https://api.hubapi.com/crm/v3/properties/contacts/events_attended',
      { headers: hubspotHeaders() }
    );
    eventOptionsCache = { data: res.data.options, expiresAt: now + CACHE_TTL_MS };
  }
  return eventOptionsCache.data;
}

function findEventOption(eventLabel, options) {
  return options.find(
    opt => opt.label.trim().toLowerCase() === eventLabel.trim().toLowerCase()
  ) || null;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/event-forms/:formId/attendees', async (req, res) => {
  try {
    const { formId } = req.params;

    const forms = await getCachedEventForms();
    const form = forms.find(f => f.id === formId);
    if (!form) return res.status(404).json({ error: 'Event form not found' });

    const eventLabel = stripEventPrefixServer(form.name);
    const options = await getEventsAttendedOptions();
    const option = findEventOption(eventLabel, options);

    if (!option) {
      return res.status(422).json({
        error: `No "${eventLabel}" option exists on the events_attended property yet. Add it in HubSpot: Settings → Properties → events_attended.`,
      });
    }

    // 1. Pull every submission for this form.
    const submissions = await fetchFormSubmissions(formId);
    console.log(JSON.stringify(submissions[0], null, 2))
    const submitters = submissions.map(s => parseSubmissionValues(s.values));
    const emails = [...new Set(submitters.map(s => s.email).filter(Boolean))];

    if (emails.length === 0) return res.json([]);

    // 2. Batch-resolve all submitters to CRM contacts by email in ONE call
    //    (instead of one lookup per attendee), pulling their current
    //    events_attended value so checkboxes reflect real saved state.
    const batchRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/batch/read',
      {
        idProperty: 'email',
        inputs: emails.map(email => ({ id: email })),
        properties: ['email', 'firstname', 'lastname', 'phone', 'zip', 'events_attended'],
      },
      { headers: hubspotHeaders() }
    );

    const contactsByEmail = {};
    for (const contact of batchRes.data.results) {
      const email = contact.properties.email?.toLowerCase();
      if (email) contactsByEmail[email] = contact;
    }

    // 3. Merge: CRM data wins where a matching contact exists (it's the
    //    source of truth and may have been corrected since submission);
    //    fall back to raw submission data otherwise.
    const attendees = submitters.map(sub => {
      const contact = sub.email ? contactsByEmail[sub.email.toLowerCase()] : null;
      const attendedValues = contact?.properties.events_attended?.split(';').filter(Boolean) || [];

      return {
        contactId: contact?.id || null,
        firstName: contact?.properties.firstname || sub.firstName || '',
        lastName: contact?.properties.lastname || sub.lastName || '',
        phone: contact?.properties.phone || sub.phone || '',
        email: sub.email || '',
        postalCode: contact?.properties.zip || sub.postalCode || '',
        attended: attendedValues.includes(option.value),
      };
    });

    res.json(attendees);
  } catch (err) {
    console.error('Failed to fetch attendees:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not load attendee list' });
  }
});

app.post('/api/event-forms/:formId/attendance', async (req, res) => {
  try {
    const { formId } = req.params;
    const { contactId, attended } = req.body;

    if (!contactId || typeof attended !== 'boolean') {
      return res.status(400).json({ error: 'Missing contactId or attended' });
    }

    const forms = await getCachedEventForms();
    const form = forms.find(f => f.id === formId);
    if (!form) return res.status(404).json({ error: 'Event form not found' });

    const eventLabel = stripEventPrefixServer(form.name);
    const options = await getEventsAttendedOptions();
    const option = findEventOption(eventLabel, options);
    if (!option) {
      return res.status(422).json({ error: `No matching events_attended option for "${eventLabel}"` });
    }

    const contactRes = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      { params: { properties: 'events_attended' }, headers: hubspotHeaders() }
    );

    const currentValues = new Set(
      (contactRes.data.properties.events_attended || '').split(';').filter(Boolean)
    );

    if (attended) currentValues.add(option.value);
    else currentValues.delete(option.value);

    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      { properties: { events_attended: [...currentValues].join(';') } },
      { headers: hubspotHeaders() }
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update attendance:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not update attendance' });
  }
});

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
    const referCode = paymentIntent.metadata?.referrer_id || '';

    // 2. Look up existing HubSpot contact by email
    const existing = await findContactByEmail(email);

    if (existing) {
      const currentTotal = parseFloat(existing.properties.totalindividualdonations || 0);
      const newTotal = parseFloat((currentTotal + donationAmount).toFixed(2));

      const properties = {
        firstname: firstName,
        lastname: lastName,
        totalindividualdonations: newTotal,
        last_donation_amount: donationAmount,
        latest_donation_date: donationDate,
        is_donor: true,
      };

      // Only set referred_by_id if they don't already have one — preserves
      // whoever referred them first (e.g. via the membership flow) instead
      // of letting a later donation link overwrite it.
      if (referCode && !existing.properties.referred_by_id) {
        properties.referred_by_id = referCode;
      }

      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${existing.id}`,
        { properties },
        { headers: hubspotHeaders() }
      );

      console.log(`Updated contact ${existing.id} (${email}): total now $${newTotal}`);
    } else {
      const properties = {
        email,
        firstname: firstName,
        lastname: lastName,
        totalindividualdonations: donationAmount,
        last_donation_amount: donationAmount,
        latest_donation_date: donationDate,
        is_donor: true,
      };

      if (referCode) {
        properties.referred_by_id = referCode;
      }

      await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        { properties },
        { headers: hubspotHeaders() }
      );

      console.log(`Created new contact (${email}): first donation $${donationAmount}`);
    }

    // Prevent tonight's sync.js run from re-adding this same charge's amount
    try {
      await stripe.paymentIntents.update(paymentIntentId, {
        metadata: { hubspot_synced: 'true' },
      });
    } catch (err) {
      console.warn(`[donation-complete] Could not mark PI ${paymentIntentId} as synced: ${err.message}`);
    }

    if (referCode) {
      await attributeDonationReferral(referCode, donationAmount);
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

function buildDonationReferralLink(code) {
  return `https://www.leefairclough.ca/donate?donate_refer_id=${code}`;
}

/**
 * Create a per-referrer Google Sheet for a HubSpot contact and patch the
 * relevant properties onto it in one write. `extra` optionally carries
 * refer_code/referral_link when they're being generated in this same
 * request, saving a second HubSpot round-trip.
 *
 * Never throws — sheet creation is a nice-to-have on top of the core
 * referral link, so a Google API hiccup shouldn't break link generation.
 * Returns the sheet URL, or null if creation failed.
 */
async function createAndAttachSheet(contact, extra = {}) {
  try {
    const { sheetId, sheetUrl } = await referralSheets.createReferrerSheet({
      email: contact.properties.email,
      firstName: contact.properties.firstname || '',
      lastName: contact.properties.lastname || '',
    });

    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`,
      { properties: { referral_sheet_id: sheetId, referral_sheet_url: sheetUrl, ...extra } },
      { headers: hubspotHeaders() }
    );

    return sheetUrl;
  } catch (err) {
    console.error('Referral sheet creation failed:', err.response?.data || err.message);

    // Still persist refer_code/referral_link if we generated them this
    // request, so the next request doesn't mint a mismatched new code.
    if (Object.keys(extra).length) {
      try {
        await axios.patch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`,
          { properties: extra },
          { headers: hubspotHeaders() }
        );
      } catch (_) {}
    }
    return null;
  }
}

/**
 * Email the referrer their membership link, donation link, and personal
 * stats-sheet link. Uses Resend (same as sync.js) — silently skips if
 * RESEND_API_KEY isn't set.
 */
async function sendReferralEmail(email, firstName, { referralLink, donationReferralLink, sheetUrl }) {
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY not set — skipping referral link email.');
    return;
  }

  const { Resend } = require('resend');
  const resend = new Resend(RESEND_API_KEY);

  // const sheetRow = sheetUrl
  //   ? `<p><strong>Your referral stats:</strong><br><a href="${sheetUrl}">${sheetUrl}</a></p>
  //      <p style="font-size:12px;color:#888;">The stats sheet requires signing in with a Google account matching this email address.</p>`
  //   : '';

  // const html = `
  //   <div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;">
  //     <h2 style="color:#960018;">Thanks${firstName ? `, ${firstName}` : ''}! Here are your referral links.</h2>
  //     <p><strong>Membership referral link:</strong><br><a href="${referralLink}">${referralLink}</a></p>
  //     <p><strong>Donation referral link:</strong><br><a href="${donationReferralLink}">${donationReferralLink}</a></p>
  //     ${sheetRow}
  //     <p style="font-size:12px;color:#888;margin-top:16px;">Share these with friends and family to help grow the campaign.</p>
  //   </div>
  // `;

  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#960018;">Thanks${firstName ? `, ${firstName}` : ''}! Here are your referral links.</h2>
      <p><strong>Membership referral link:</strong><br><a href="${referralLink}">${referralLink}</a></p>
      <p><strong>Donation referral link:</strong><br><a href="${donationReferralLink}">${donationReferralLink}</a></p>
      <p style="font-size:12px;color:#888;margin-top:16px;">Share these with friends and family to help grow the campaign.</p>
    </div>
  `;

  try {
    await resend.emails.send({
      from: RESEND_FROM || 'Campaign <onboarding@resend.dev>',
      to: [email],
      subject: 'Your referral links',
      html,
    });
    console.log(`[email] Referral links sent to ${email}`);
  } catch (err) {
    console.warn(`[email] Failed to send referral email to ${email}: ${err.message}`);
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * Step 1: check if a contact exists and whether they already have a link.
 * If they do, or if they exist without one yet, this returns/generates
 * everything in one shot: membership link, donation link, and stats sheet.
 */
app.post('/api/referral/lookup', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const contact = await findContactByEmail(email.trim().toLowerCase());

    if (!contact) {
      return res.json({ exists: false });
    }

    // Already fully set up — idempotent, but still (re)send the email as a
    // convenience in case they lost their original links.
    if (contact.properties.referral_link && contact.properties.refer_code) {
      // let sheetUrl = contact.properties.referral_sheet_url;

      // Backfill: link predates the per-referrer sheet feature, or the
      // sheet failed to create last time.
      
      // if (!sheetUrl) {
      //   sheetUrl = await createAndAttachSheet(contact);
      // }

      const donationReferralLink = contact.properties.donation_referral_link
        || buildDonationReferralLink(contact.properties.refer_code);

      if (!contact.properties.donation_referral_link) {
        await axios.patch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`,
          { properties: { donation_referral_link: donationReferralLink } },
          { headers: hubspotHeaders() }
        ).catch(err =>
          console.warn(`Could not backfill donation_referral_link for ${contact.id}:`, err.message)
        );
      }

      // await sendReferralEmail(contact.properties.email, contact.properties.firstname, {
      //   referralLink: contact.properties.referral_link, donationReferralLink, sheetUrl,
      // });

      // return res.json({
      //   exists: true,
      //   referralLink: contact.properties.referral_link,
      //   donationReferralLink,
      //   sheetUrl,
      // });

      
      return res.json({
        exists: true,
        referralLink: contact.properties.referral_link,
        donationReferralLink,
      });
    }

    // Contact exists in HubSpot (e.g. from a prior donation) but has never
    // generated a link — generate everything now using the name HubSpot
    // already has on file, no extra fields required from them.
    const referCode = buildReferralCode(
      contact.properties.firstname || '',
      contact.properties.lastname || '',
      contact.id
    );
    const referralLink = buildReferralLink(referCode);
    const donationReferralLink = buildDonationReferralLink(referCode);

    // const sheetUrl = await createAndAttachSheet(contact, {
    //   refer_code: referCode,
    //   referral_link: referralLink,
    //   donation_referral_link: donationReferralLink,
    // });

    try {
      await patchReferralProperties(contact.id, {
        refer_code: referCode,
        referral_link: referralLink,
        donation_referral_link: donationReferralLink,
      });
    } catch (err) {
      console.error(`Could not save referral properties for ${contact.id}:`, err.response?.data || err.message);
    }

    // await sendReferralEmail(contact.properties.email, contact.properties.firstname, {
    //   referralLink, donationReferralLink, sheetUrl,
    // });

    // res.json({ exists: true, referralLink, donationReferralLink, sheetUrl });
    res.json({ exists: true, referralLink, donationReferralLink });
  } catch (error) {
    console.error('Referral lookup error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Step 2 (only if lookup returned exists:false): create the contact
 * with the fields collected in-page, then generate the link + sheet.
 */
app.post('/api/referral/create', async (req, res) => {
  try {
    const { email, firstName, lastName, phone, postalCode } = req.body;
    if (!email || !firstName || !lastName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const trimmedEmail = email.trim().toLowerCase();

    const createRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts',
      {
        properties: {
          email: trimmedEmail,
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
    const donationReferralLink = buildDonationReferralLink(referCode);

    // const sheetUrl = await createAndAttachSheet(
    //   { id: contactId, properties: { email: trimmedEmail, firstname: firstName, lastname: lastName } },
    //   { refer_code: referCode, referral_link: referralLink, donation_referral_link: donationReferralLink }
    // );

    try {
      await patchReferralProperties(contactId, {
        refer_code: referCode,
        referral_link: referralLink,
        donation_referral_link: donationReferralLink,
      });
    } catch (err) {
      console.error(`Could not save referral properties for ${contactId}:`, err.response?.data || err.message);
    }

    // await sendReferralEmail(trimmedEmail, firstName, { referralLink, donationReferralLink, sheetUrl });
    console.log('Test');

    // res.json({ referralLink, donationReferralLink, sheetUrl });
    res.json({ referralLink, donationReferralLink });
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
cron.schedule('1 0 * * *', async () => {
  console.log('[cron] Starting nightly sync...');
  await run().catch(err => console.error('[cron] Sync failed:', err.message));
}, { timezone: 'America/Toronto' });

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));