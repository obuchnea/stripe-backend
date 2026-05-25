require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();

// Middleware
app.use(express.json());
app.use(cors({
  origin: 'https://www.leefairclough.ca' // restrict to your domain
}));

// Health check route
app.get('/', (req, res) => {
  res.send('Server is running');
});

// Create Payment Intent route
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency } = req.body;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // amount in cents (e.g. 2000 = $20.00)
      currency: currency || 'cad',
      automatic_payment_methods: {
        enabled: true, // lets Stripe handle payment method types automatically
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
    });

  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});