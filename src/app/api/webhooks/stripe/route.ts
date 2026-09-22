import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripeServer } from '@/lib/stripe/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { PendingCartItem } from '@/lib/actions/stripe';

export async function POST(request: NextRequest) {
  // 1. Read the raw body and signature header
  //    - body: await req.text()
  //    - signature: req.headers.get('stripe-signature')
  //    - if no signature, return 400
  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    // returning 400 here
    return NextResponse.json({ received: false }, { status: 400});
  }

  // 2. Verify the signature and construct the event
  //    - stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!)
  //    - wrap in try/catch - if it throws, the signature is invalid, return 400

  // 3. Handle the event
  //    - if event.type === 'payment_intent.succeeded':
  //      call handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent)
  try {
    const event = getStripeServer().webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);

    if (event?.type === "payment_intent.succeeded") {
      await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
    }
  } catch (error) {
    console.error(`An error occured: ${error}`);
    
    // returning 400 here
    return NextResponse.json({ received: false }, { status: 400 });
  }


  // 4. Return 200 so Stripe knows we received it
  return NextResponse.json({ received: true });
}


async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  const supabase = createAdminClient();

  // 1. Idempotency check
  //    - query orders table for stripe_payment_intent_id === paymentIntent.id
  //    - if a row exists, an order was already created (client-side happy path ran)
  //    - return early - nothing to do
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("*")
    .eq("stripe_payment_intent_id", paymentIntent.id)
    .single();

  if (order) {
    await supabase.from('pending_orders').delete().eq('payment_intent_id', paymentIntent.id);
    return; // return early
  }


  // 2. Fetch the pending order
  //    - query pending_orders where payment_intent_id === paymentIntent.id
  //    - if not found, log an error and return (nothing we can do)
  const { data: pendingOrder, error: pendingOrderError } = await supabase
    .from("pending_orders")
    .select("*")
    .eq("payment_intent_id", paymentIntent.id)
    .single();
  
  if (!pendingOrder) {
    console.error(`Error: Order does not exist in system: ${pendingOrderError}`);
    return;
  }

  for (const item of pendingOrder.cart_items) {
    const { data: reservationToCheck, error: reservationToCheckError } = await supabase
      .from("stock_reservations")
      .select("id")
      .eq("product_id", item.product_id)
      .eq("reserved_by", pendingOrder.user_id)
      .gt("expires_at", new Date().toISOString())
      .single();

      if (!reservationToCheck) {
        console.error(`Error: Reservation does not exist in system: ${reservationToCheckError}`);

        await getStripeServer().refunds.create({
          payment_intent: paymentIntent.id
        });
        return;
      }
  }

  // 3. Build and insert the order row
  //    - same logic as createOrder() in orders.ts: generate order number, insert into orders
  //    - use the pendingOrder fields for all values
  let currentDate = new Date();
  let year = currentDate.getFullYear();
  let month = String(currentDate.getMonth() + 1).padStart(2, '0');
  let day = String(currentDate.getDate()).padStart(2, '0');
  let random9AlphaNumChars = Math.random().toString(36).substring(2, 11).toUpperCase();
  const orderNumber = `ORD-${year}${month}${day}${random9AlphaNumChars}`;

  let orderInsert = {
    user_id: pendingOrder.user_id,
    order_number: orderNumber,
    status: "pending",
    subtotal: pendingOrder.subtotal,
    tax: pendingOrder.tax,
    shipping: pendingOrder.shipping,
    total: pendingOrder.total,
    shipping_name: pendingOrder.shipping_address.name,
    shipping_email: pendingOrder.shipping_address.email,
    shipping_phone: pendingOrder.shipping_address.phone,
    shipping_address_line1: pendingOrder.shipping_address.address_line1,
    shipping_address_line2: pendingOrder.shipping_address.address_line2,
    shipping_city: pendingOrder.shipping_address.city,
    shipping_state: pendingOrder.shipping_address.state,
    shipping_postal_code: pendingOrder.shipping_address.postal_code,
    shipping_country: pendingOrder.shipping_address.country,
    stripe_payment_intent_id: paymentIntent.id,
    payment_status: "succeeded"
  };

  const { data: orderToCreate, error: orderToCreateError  } = await supabase
  .from('orders')
  .insert(orderInsert)
  .select()
  .single();

  if (orderToCreateError) {
    console.error(`Error: Unable to create order: ${orderToCreateError.message}`);
    return;
  }


  // 4. Insert order_items
  //    - map pendingOrder.cart_items -> order_items rows (same shape, just add order_id)
  let orderItemsInsert = (pendingOrder.cart_items as PendingCartItem[]).map((item) => ({
    // ensure that object's attributes here match the exact spelling of columns in DB
    order_id: orderToCreate.id, //  we are inserting the newly created order's corresponding order items
    product_id: item.product_id,
    product_name: item.product_name,
    product_image: item.product_image,
    price: item.price,
    quantity: item.quantity
  }));

  const { error: orderItemsError  } = await supabase
  .from('order_items')
  .insert(orderItemsInsert);

  if (orderItemsError) {
    console.error(`Error: Unable to create pending order: ${orderItemsError.message}`);
    return;
  }



  // 5. Reduce stock
  //    - loop cart_items, call reduce_stock RPC for each
  for (const cartItem of pendingOrder.cart_items) {
    const { error: stockError } = await supabase
      .rpc(
        'reduce_stock',
        { product_id: cartItem.product_id,
          quantity: cartItem.quantity
        }
      ) // explicitly state the matched value 
      // CREATE OR REPLACE FUNCTION reduce_stock has return void, so no need for data: xxxData attribute here
    if (stockError) throw stockError;  
  }


  // 6. Clean up - delete the pending_orders row
  const { error: pendingOrderToDeleteError  } = await supabase
  .from('pending_orders')
  .delete()
  .eq("id", pendingOrder.id);

  if (pendingOrderToDeleteError) {
    console.error(`Error: Unable to delete pending order: ${pendingOrderToDeleteError.message}`);
  }
}
