// Server-only Stripe SDK instance.
// Import this ONLY in server actions and API routes - never in client components.
// The secret key must never reach the browser.

import Stripe from 'stripe';
import { stripeConfig } from './config';

// Initialise the Stripe SDK lazily and export it as `getStripeServer()`
// You need two things:
//   1. The secret key (from stripeConfig)
//   2. The API version: '2024-11-20.acacia'  ← Stripe requires you to pin this
//
// Note: new Stripe(key, { apiVersion: '...' })

let stripeClient: Stripe | null = null;

export function getStripeServer(): Stripe {
  if (!stripeClient) {
    const secretKey = stripeConfig.secretKey;

    if (!secretKey) {
      throw new Error("Stripe Secret Key not set as an env var.");
    }

    stripeClient = new Stripe(secretKey, { apiVersion: '2026-01-28.clover' });
  }

  return stripeClient;
}