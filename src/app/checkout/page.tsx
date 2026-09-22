'use client';

// The checkout page manages a two-step flow:
//   Step 1 -> Shipping address form
//   Step 2 -> Stripe payment form (only rendered once we have a clientSecret)
//
// The OrderSummary sidebar is always visible on both steps.

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Elements } from '@stripe/react-stripe-js';
import { getStripeClient } from '@/lib/stripe/client';
import { useAuth } from '@/lib/auth/auth-context';
import { useCartStore } from '@/store/useCartStore';
import { createPaymentIntent } from '@/lib/actions/stripe';
import { reserveCartStock } from '@/lib/actions/reservations';
import { getUserAddresses } from '@/lib/actions/addresses';
import { ShippingAddressForm } from '@/components/checkout/shipping-address-form';
import { PaymentForm } from '@/components/checkout/payment-form';
import { OrderSummary } from '@/components/checkout/order-summary';
import { ReservationTimer } from '@/components/checkout/reservation-timer';
import type { ShippingAddress } from '@/lib/types/order';

export default function CheckoutPage() {
  const router = useRouter();
  const { user, profile } = useAuth();
  const items = useCartStore(state => state.items);
  const subtotal = useCartStore(state => state.subtotal());
  const tax = useCartStore(state => state.tax());
  const shipping = useCartStore(state => state.shipping());
  const total = useCartStore(state => state.total());

  const [shippingDefaults, setShippingDefaults] = useState<Record<string, string | null | undefined>>({});
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);

  // Pre-fill shipping form from saved default address + profile.
  // Guard on both user AND profile: when user first resolves, profile is still
  // null (fetchProfile is async). Waiting for profile ensures the closure
  // captures real data and we only call getUserAddresses once.
  useEffect(() => {
    if (!user || !profile) return;
    getUserAddresses()
    .then((addresses) => {
      const defaultAddr = addresses.find(a => a.is_default) ?? addresses[0];
      setShippingDefaults({
        name:          defaultAddr?.name      ?? profile.full_name ?? '',
        email:         profile.email,
        phone:         defaultAddr?.phone     ?? profile.phone     ?? '',
        address_line1: defaultAddr?.address_line1 ?? '',
        address_line2: defaultAddr?.address_line2 ?? '',
        city:          defaultAddr?.city      ?? '',
        state:         defaultAddr?.state     ?? '',
        postal_code:   defaultAddr?.postal_code ?? '',
        country:       defaultAddr?.country   ?? 'AU',
      });
    })
    .finally(() => setDefaultsLoaded(true));
  }, [user, profile]);

  // Step tracker: 1 = shipping address, 2 = payment
  const [step, setStep] = useState(1);

  // These are set after the user submits shipping and we create the payment intent
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [reservationError,     setReservationError]     = useState<string | null>(null);
  const [reservationExpiresAt, setReservationExpiresAt] = useState<Date | null>(null);
  const [reservationExpired,   setReservationExpired]   = useState(false);

  // Redirect to cart if there's nothing to check out.
  // Only on step 1 - on step 2 the cart will be empty after a successful
  // payment and we don't want to override the success page redirect.
  // Guard: wait for Zustand persist to finish rehydrating from localStorage.
  // On first render items is [] (no localStorage on server), so without this
  // guard a page refresh would immediately redirect before the cart loads in.
  useEffect(() => {
    if (!useCartStore.persist.hasHydrated()) return;
    if (step === 1 && items.length === 0) router.push('/cart')
  }, [items, router, step]);

  // ============================================================
  // SHIPPING SUBMIT HANDLER
  // Called by ShippingAddressForm when the user submits their address.
  // ============================================================

  // Implement this arrow function
  // It receives a ShippingAddress and should:
  //
  // 1. Save the address to state (setShippingAddress)
  //
  // 2. Call createPaymentIntent(total) - this is a server action
  //    It returns { clientSecret, paymentIntentId }
  //
  // 3. Save clientSecret and paymentIntentId to state
  //
  // 4. Advance the step to 2 (setStep)
  //
  // Note: createPaymentIntent is async - this function must be async too
  const handleShippingSubmit = async (address: ShippingAddress) => {
    if (!user) return;
    setReservationError(null);

    // Reserve stock for every cart item before creating the payment intent.
    // If any item is out of stock, we stop here and surface the error.
    const reservationResult = await reserveCartStock(
      items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
      user.id
    );
    if (reservationResult) {
      setReservationError(reservationResult);
      return;
    }

    setShippingAddress(address);

    const cartItems = items.map((item) => ({
      product_id: item.productId,
      product_name: item.name,
      product_image: item.image,
      price: item.salePrice ?? item.price,
      quantity: item.quantity
    }));

    const paymentIntent = await createPaymentIntent(
      total,
      {
        user_id: user.id,
        cart_items: cartItems,
        shipping_address: address,
        subtotal: subtotal,
        tax: tax,
        shipping: shipping,
        total: total
      }
    );
    
    setClientSecret(paymentIntent.clientSecret);
    setPaymentIntentId(paymentIntent.paymentIntentId);
    setReservationExpiresAt(new Date(Date.now() + 15 * 60 * 1000));

    setStep(2);
  }


  // ============================================================
  // RENDER
  // ============================================================

  // proxy.ts handles the auth redirect -- but during the brief loading
  // window before auth resolves, user might be null. Render nothing.
  if (!user) return null;

  return (
    <div className="min-h-screen bg-background py-8">
      <div className="max-w-7xl mx-auto px-4">

        {/* Page header */}
        <h1 className="text-3xl font-bold mb-8">Checkout</h1>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-8 text-sm">
          <span className={step === 1 ? 'font-bold' : 'text-muted-foreground'}>
            1. Shipping
          </span>
          <span className="text-muted-foreground">→</span>
          <span className={step === 2 ? 'font-bold' : 'text-muted-foreground'}>
            2. Payment
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* Main area - left 2/3 */}
          <div className="lg:col-span-2 space-y-6">

            {/* Render the correct component based on the current step */}
            
            {step === 1 && (
              <>
                {reservationError && (
                  <p className="text-sm text-destructive border border-destructive/30 bg-destructive/5 px-4 py-3">
                    {reservationError}
                  </p>
                )}
                {!defaultsLoaded
                  ? <div className="flex items-center justify-center py-12 text-muted-foreground">Loading...</div>
                  : <ShippingAddressForm onSubmit={handleShippingSubmit} defaultValues={shippingDefaults}/>
                }
              </>
            )}

            {(step === 2 && reservationExpiresAt) && (
              <ReservationTimer
                expiresAt={reservationExpiresAt}
                onExpire={() => setReservationExpired(true)}
              />
            )}

            {(step === 2 && reservationExpired) && (
              <div className="border border-destructive/30 bg-destructive/5 px-4 py-6 text-center space-y-3">
                <p className="text-sm font-medium text-destructive">Your reservation has expired.</p>
                <p className="text-sm text-muted-foreground">Return to your cart and go through checkout again to reserve stock.</p>
                <a href="/cart" className="inline-block text-sm underline">Return to cart</a>
              </div>
            )}

            {(step === 2 && !reservationExpired && clientSecret && shippingAddress && paymentIntentId) && (
              <Elements
                stripe={getStripeClient()}
                options={{ clientSecret }}
              >
                <PaymentForm
                  shippingAddress={shippingAddress}
                  paymentIntentId={paymentIntentId}
                />
              </Elements>
            )}

          </div>

          {/* Sidebar - right 1/3 */}
          <div className="lg:col-span-1">
            <OrderSummary />
          </div>

        </div>
      </div>
    </div>
  )
}
