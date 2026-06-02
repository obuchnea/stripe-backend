// debug.js
require('dotenv').config();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

stripe.charges.list({ limit: 5 }).then(r => 
  r.data.forEach(c => console.log(c.id, c.billing_details?.email, c.receipt_email))
);