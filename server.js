require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// Health check
app.get('/', (req, res) => {
  res.send('Server is running');
});

// Create Payment Intent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: currency || 'cad',
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle successful donation + HubSpot sync
app.post('/donation-complete', async (req, res) => {
  try {
    const { email, firstName, lastName, amount, paymentIntentId } = req.body;

    // Verify the payment actually succeeded with Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }

    const donationAmount = (amount / 100).toFixed(2);
    const donationDate = new Date().toISOString().split('T')[0];

    // Upsert contact in HubSpot (creates new or updates existing by email)
    await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts',
      {
        properties: {
          email,
          firstname: firstName,
          lastname: lastName,
          last_donation_amount: donationAmount,
          last_donation_date: donationDate,
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    ).catch(async (err) => {
      // If contact already exists (409 conflict), update them instead
      if (err.response?.status === 409) {
        const existingId = err.response.data.message.match(/ID: (\d+)/)?.[1];
        if (existingId) {
          await axios.patch(
            `https://api.hubapi.com/crm/v3/objects/contacts/${existingId}`,
            {
              properties: {
                last_donation_amount: donationAmount,
                last_donation_date: donationDate,
              }
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
              }
            }
          );
        }
      } else {
        throw err;
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Donation complete error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));