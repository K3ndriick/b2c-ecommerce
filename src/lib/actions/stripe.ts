'use server';

import { getStripeServer } from '@/lib/stripe/server';
import { stripeConfig } from '@/lib/stripe/config';
import { ShippingAddress } from '../types';
import { createAdminClient } from '../supabase/admin';

// Creates a Stripe PaymentIntent on the server and returns the clientSecret
// to the browser so it can render the payment form and confirm the payment.
//
// amount: the order total in dollars (e.g. 150.00)
// Stripe requires amounts in cents (e.g. 15000) - you'll need to convert.
// OFFICIAL STRIPE DOCS: https://docs.stripe.com/api/payment_intents/create

// new shapes for storing pending orders
export type PendingCartItem = {
  product_id: string
  product_name: string
  product_image: string | null
  price: number
  quantity: number
}

type PaymentIntentData = {
  user_id: string,
  cart_items: PendingCartItem[],
  shipping_address: ShippingAddress,
  subtotal: number,
  tax: number,
  shipping: number,
  total: number,
}

export const createPaymentIntent = async (amount: number, paymentIntentData: PaymentIntentData) => {
  try {
    // Call stripe.paymentIntents.create() with:
    //   - amount: converted to cents (multiply by 100, round to avoid floating point issues)
    //   - currency: from stripeConfig
    //   - automatic_payment_methods: { enabled: true }
    //     (this lets Stripe show the right payment options for the customer's region)
    //
    const paymentIntent = await getStripeServer().paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: stripeConfig.currency,
      automatic_payment_methods: { enabled: true }
    });

    // we use data recieved from address form to create our pending orders data 
    const pendingOrder = {
      user_id: paymentIntentData.user_id, // customer's ID
      payment_intent_id: paymentIntent.id,
      cart_items: paymentIntentData.cart_items,
      shipping_address: paymentIntentData.shipping_address,
      subtotal: paymentIntentData.subtotal,
      tax: paymentIntentData.tax,
      shipping: paymentIntentData.shipping,
      total: paymentIntentData.total,
    }

    const supabase = createAdminClient();

    const { error } = await supabase
      .from("pending_orders")
      .insert(pendingOrder);

    if (error) {
      console.error(`Failed to insert pending order: ${error.message}`)
      throw error;
    }

    // Return an object with two fields:
    //   - clientSecret: paymentIntent.client_secret
    //   - paymentIntentId: paymentIntent.id
    return {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    }

  } catch (error) {
    console.error('Failed to create payment intent:', error);
    throw new Error('Failed to create payment intent');
  }
}
