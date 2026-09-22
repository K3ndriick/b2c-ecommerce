// Browser-only Stripe.js loader.
// Uses the singleton pattern - loadStripe() is called exactly once
// no matter how many times getStripe() is called or how many re-renders occur.

import { loadStripe } from '@stripe/stripe-js';
import { stripeConfig } from './config';

// Singleton pattern
//
// You need:
//   1. A variable to hold the stripe promise (starts as undefined)
//   2. A exported function `getStripe` that:
//      - checks if the variable already has a value
//      - if not: calls loadStripe() with the publishable key and assigns it
//      - always returns the variable
//
// Note: the variable type is ReturnType<typeof loadStripe>

let stripePromise: ReturnType<typeof loadStripe>;

export const getStripeClient = () => {
    if (!stripePromise) {
    stripePromise = loadStripe(stripeConfig.publishableKey);
  }
  return stripePromise;
}