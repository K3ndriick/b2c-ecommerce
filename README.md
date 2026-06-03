# PowerProShop

A full-stack e-commerce and business management platform built for a single-owner gym equipment retail and repair shop - a business that previously ran entirely on pen and paper with no digital presence. **37 pages. 15+ user flows. Built solo.**

The platform digitises every aspect of the business: online product sales, appointment booking for repair and installation services, customer accounts, and a complete admin layer for the owner to manage everything remotely. It replaces notebooks, Excel spreadsheets, and phone-call-only orders with a production-ready system.

> Currently in final security review before production launch.

**[Case Study](src/docs/CASE_STUDY.md)** - full project narrative, key decisions, hard problems, lessons learned.

## Overview

Built on a unified Next.js stack with Supabase, Stripe, and Upstash Redis. The original CakePHP system covered products and appointment bookings. This rebuild retains and modernises those core features, then extends the platform with a full admin layer that did not previously exist: sales analytics, order management, review moderation, inventory control, supplier management, and purchase orders.

The rebuild also introduced Stripe payment processing with server-side webhook handling, a stock reservation system, Row Level Security across all database tables, and a role-based admin access model.

## How It Works

```
Browser
  Client Components (Zustand, React Hook Form)
  Server Components (data fetching, no client JS)
      |
      | Next.js Server Actions ('use server')
      | No REST API layer - components call typed server functions directly
      |
  Supabase (PostgreSQL + Auth)
      Row Level Security enforces data access at the database level
      auth.users -> profiles -> orders -> order_items
      products -> reviews, stock_adjustments, stock_reservations
      services -> appointments
      suppliers -> purchase_orders -> purchase_order_items
      |
  Stripe
      PaymentIntents created server-side
      Webhooks notify the server on payment_intent.succeeded
      Orders written server-side from the webhook, not from the browser
```

**Request lifecycle - checkout as an example:**
1. User submits shipping address - stock is reserved atomically via `reserve_stock()` RPC (15-min TTL)
2. Server creates a Stripe PaymentIntent with cart + shipping metadata attached
3. Browser collects card details via Stripe Elements (card data never touches this server)
4. Stripe processes the payment and fires `payment_intent.succeeded` to the webhook endpoint
5. Webhook verifies the Stripe signature, reads metadata, creates the order row, decrements stock
6. If the browser crashes after payment but before confirmation - the webhook creates the order anyway

**Auth flow:**
- `proxy.ts` (Next.js edge middleware) runs on every request, calls `supabase.auth.getUser()` to verify and refresh the session token
- Protected routes (`/checkout`, `/dashboard`, `/admin`) redirect to `/login` if no session
- Admin routes additionally check `profiles.role = 'admin'` in the layout and in every server action - the layout redirect is a UI gate, the server action check is the actual enforcement
- `getUser()` is used throughout (not `getSession()`) - verifies the token server-side on every call rather than trusting cookies alone

## Tech Stack

- **Framework** - [Next.js 16](https://nextjs.org) (App Router, React 19, TypeScript)
- **Database + Auth** - [Supabase](https://supabase.com) (PostgreSQL, Row Level Security, Auth)
- **Payments** - [Stripe](https://stripe.com) (PaymentIntents, webhooks, AUD)
- **Styling** - Tailwind CSS v3 + [shadcn/ui](https://ui.shadcn.com) (Radix UI primitives)
- **State** - [Zustand](https://docs.pmnd.rs/zustand) (cart + filters, localStorage persistence)
- **Forms** - React Hook Form + Zod
- **Email** - Nodemailer / Mailtrap (dev), swap to Resend/SendGrid for production
- **Hosting** - [Vercel](https://vercel.com)

## Features

**Customer-facing**
- Product catalog with category, brand, price range, in-stock, and on-sale filters
- Full-text product search with autocomplete dropdown
- Persistent shopping cart with sale price handling, tax, and free shipping threshold
- Stripe checkout with PaymentElements (card payments, AUD)
- Order history and order detail pages
- Product reviews with verified purchase enforcement and star rating summaries
- Service catalog and online appointment booking with real-time slot availability
- Upcoming/past appointment history in user dashboard
- Saved shipping addresses, profile management, password change

**Admin**
- Sales analytics overview (revenue, orders, pending items, low stock alerts)
- Product management - full CRUD, soft delete, featured flags
- Order management - list, detail view, status updates
- Appointment management - list, confirm, cancel, status updates
- Review moderation - approve/reject queue with state machine enforcement
- User/customer directory
- Inventory - low stock alerts, stock adjustments with audit log
- Supplier management - CRUD, active/inactive toggle
- Purchase orders - create, add line items, mark as received (auto-increments stock)

**Infrastructure**
- Stripe webhook handler - orders created server-side on `payment_intent.succeeded`, not client-side. Idempotent via unique constraint on `stripe_payment_intent_id`.
- Stock reservation system - 15-minute holds placed atomically during checkout; released on payment success or expiry. Prevents overselling when two users buy the last unit simultaneously.
- Row Level Security on all tables - database enforces access rules regardless of application code.
- Role-based admin access - `profiles.role = 'admin'` required; checked in layout, not just middleware.

## Architecture Notes

**Server Actions over API routes.** All data fetching and mutations use Next.js Server Actions (`'use server'`). Components call typed server functions directly - no `fetch()`, no JSON serialisation, no API routes to maintain. Secret keys (Supabase service role, Stripe secret) stay on the server with zero extra effort.

**Three Supabase clients, each with a different trust level.**

| File                         | Used in                           | Trust level                                           |
|------------------------------|-----------------------------------|-------------------------------------------------------|
| `src/lib/supabase/client.ts` | Client Components, Zustand stores | Anon key, RLS applies, browser cookies for auth       |
| `src/lib/supabase/server.ts` | Server Components, Server Actions | Anon key, RLS applies, reads cookies from the request |
| `src/lib/supabase/admin.ts`  | Admin Server Actions only         | Service role key, bypasses RLS entirely               |

Using the wrong client in the wrong context either silently fails auth (anon client in a server action) or exposes too much data (admin client where user-scoped access is expected).

**State management - three mechanisms for three different jobs.**

| Mechanism                   | What it manages                  | Why                                                      |
|-----------------------------|----------------------------------|----------------------------------------------------------|
| Zustand `useCartStore`      | Cart items, quantities, totals   | Needs localStorage persistence across page navigations   |
| Zustand `useFilterStore`    | Product filters, sort, view mode | Needs localStorage persistence across page navigations   |
| React Context `AuthContext` | User session, profile            | App-wide; Supabase handles token persistence via cookies |
| URL search params           | Active category filter           | Makes filtered URLs shareable and SSR-compatible         |

**Key system design decisions.**

- **Idempotent order creation** - a unique constraint on `stripe_payment_intent_id` means Stripe can retry the `payment_intent.succeeded` webhook multiple times without creating duplicate orders.
- **Atomic stock operations** - `reserve_stock()` and `reduce_stock()` are PostgreSQL RPC functions that check availability and write in a single transaction. Two simultaneous buyers cannot both claim the last unit.
- **Append-only stock ledger** - `stock_adjustments` rows are never updated or deleted. Current stock is the product's base quantity plus the sum of all adjustment deltas. Audit history is always preserved.
- **Derived slot availability** - appointment slots are not stored. Available times are computed on request from service duration, business hours, and existing bookings. Storing availability would require keeping it in sync with every booking and cancellation.
- **Review state machine** - reviews move through `pending -> approved` or `pending -> rejected`. Valid transitions are enforced in the server action before any database write. A CHECK constraint on the `status` column provides a second enforcement layer at the database level.

## Project Docs

| Document | What it covers |
|---|---|
| [Case Study](src/docs/CASE_STUDY.md) | Full project narrative - problem, decisions, hard problems, lessons learned |
| [Architecture Overview](ARCHITECTURE_OVERVIEW.md) | High-level system summary with layered topology diagrams |
| [Architecture](src/docs/ARCHITECTURE.md) | System shape, codebase structure, DB schema, security layers |
| [Diagrams](src/docs/DIAGRAMS.md) | Mermaid service-topology and checkout/payment-flow diagrams |
| [PRD](src/docs/PRD.md) | Product requirements by phase, success metrics, constraints |
| [Data Flow](src/docs/DATA_FLOW.md) | Request traces for checkout, auth, browsing, cart |
| [State Management](src/docs/STATE_MANAGEMENT.md) | Zustand stores, React Context, URL params |
| [Design Doc](src/docs/DESIGN_DOC.md) | Color system, typography, spacing, component patterns |
| [Database Schema](src/docs/DATABASE_SCHEMA.md) | ERD, all 13 tables, DB functions, key design patterns |
| [Client Details](src/docs/CLIENT_DETAILS.md) | Business context, personas, processes being digitised |

---

## Getting Started

### Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project
- A [Stripe](https://stripe.com) account (test mode is fine)
- [Stripe CLI](https://stripe.com/docs/stripe-cli) (for local webhook testing)

### Installation

```bash
npm install
```

### Environment Variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

See [Environment Variables](#environment-variables) below for descriptions of each key.

### Database Setup

Run the SQL files in `src/database/schema/` against your Supabase project in order (001 to 008). Then optionally seed product data:

```bash
# In the Supabase SQL editor, run each file in src/database/schema/ in order
# Then run src/database/seeds/ to populate sample products
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

**To test Stripe webhooks locally:**

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Copy the webhook signing secret printed by the CLI into `STRIPE_WEBHOOK_SECRET` in `.env.local`.

### Build

```bash
npm run build
npm run start
```

## Environment Variables

| Variable                             | Required  | Description                                                     |
|--------------------------------------|-----------|-----------------------------------------------------------------|
| `NEXT_PUBLIC_SUPABASE_URL`           | Yes       | Your Supabase project URL                                       |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`      | Yes       | Supabase anon/public key                                        |
| `SUPABASE_SERVICE_ROLE_KEY`          | Yes       | Supabase service role key - server only, never expose to client |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Yes       | Stripe publishable key                                          |
| `STRIPE_SECRET_KEY`                  | Yes       | Stripe secret key - server only                                 |
| `STRIPE_WEBHOOK_SECRET`              | Yes       | Webhook signing secret from Stripe CLI or dashboard             |
| `MAILTRAP_HOST`                      | Yes (dev) | Mailtrap SMTP host                                              |
| `MAILTRAP_PORT`                      | Yes (dev) | Mailtrap SMTP port                                              |
| `MAILTRAP_USER`                      | Yes (dev) | Mailtrap SMTP username                                          |
| `MAILTRAP_PASS`                      | Yes (dev) | Mailtrap SMTP password                                          |

For production, replace the Mailtrap variables with `RESEND_API_KEY` (or equivalent) and update `src/lib/email.ts`.

## Test Card Numbers

The app runs in Stripe test mode. Use these card numbers in the checkout:

| Card         | Number                |
|--------------|-----------------------|
| Success      | `4242 4242 4242 4242` |
| Decline      | `4000 0000 0000 0002` |
| Requires 3DS | `4000 0025 0000 3155` |

Any future expiry date and any 3-digit CVC work.

## Known Limitations

- **Email in production** - currently configured for Mailtrap (dev SMTP). Switch `src/lib/email.ts` to Resend or SendGrid before going live, and configure SPF/DKIM/DMARC.
- **Stripe live mode** - test mode only. Flip to live keys and remove test card references before launch.
- **Social auth** - email/password only. Google/GitHub OAuth is not implemented.
- **Single currency** - AUD only.

## AI-Assisted Development

This project was built using Anthropic's Claude Code as a co-programming partner throughout development. Rather than using AI as a code generator, the workflow was collaborative - the developer drove architecture decisions, feature scope, and implementation direction, while Claude Code contributed through active participation in the process.

That participation included:

- **Security review** - identifying gaps like missing server-side role checks across all admin server actions, RLS policies that allowed any authenticated user to write to the products table, and the auth distinction between `getUser()` and `getSession()`
- **Documentation** - generating and refining technical documentation including this README, the architecture guide, and SQL schema files
- **Pattern suggestions** - proposing implementation approaches such as the `requireAdmin()` guard pattern and idempotency via unique constraints, each reviewed and understood before being applied

All suggestions were treated as a senior colleague's recommendation - evaluated, questioned where needed, and only applied once the reasoning was clear.

## License

[All Rights Reserved](LICENSE) - No use, copying, or distribution permitted without explicit written permission.
