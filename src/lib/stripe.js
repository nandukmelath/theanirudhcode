const Stripe = require('stripe');

let _instance = null;

function getStripe() {
  if (!_instance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY not set in env');
    }
    _instance = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-04-10',
    });
  }
  return _instance;
}

module.exports = { getStripe };
