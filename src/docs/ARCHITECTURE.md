# Architecture

This document covers the structural shape of PowerProShop: how the codebase is organised, how each layer communicates, how the database is designed, and how security is enforced. For request-level traces through specific user flows, see [DATA_FLOW.md](./DATA_FLOW.md). For client state management decisions, see [STATE_MANAGEMENT.md](./STATE_MANAGEMENT.md). For Mermaid diagrams of the service topology and checkout/payment flow, see [DIAGRAMS.md](./DIAGRAMS.md).

---

## System Shape

PowerProShop is a **monolithic full-stack application** - one codebase, one deployment. There is no separate backend service, no API gateway, and no microservices. The Next.js App Router serves as both the frontend and the backend.

```
[Browser]
    |
    +-- [Vercel Edge Network]
    |       |
    |       +-- Edge Middleware (auth checks, rate limiting)
    |       |
    |       +-- Next.js App Router
    |             |
    |             +-- Server Components  (data fetching, SSR)
    |             +-- Client Components  (interactivity, state)
    |             +-- Server Actions     (mutations, secure operations)
    |             +-- API Routes         (Stripe webhook)
    |
    +-- [Supabase]          PostgreSQL database + Auth + Storage
    +-- [Stripe]            Payment processing + Webhook delivery
    +-- [Upstash Redis]     Rate limiting (auth endpoints)
    +-- [Google Places]     Address autocomplete
```

---

## Codebase Structure

```
src/
  app/                    Next.js App Router pages and layouts
    (auth)/               Auth pages (login, signup, forgot-password)
    admin/                Admin dashboard - role-gated
    api/
      webhooks/stripe/    Stripe webhook handler
    cart/
    checkout/
    dashboard/            Customer account area
    products/
    services/
    page.tsx              Homepage

  components/
    admin/                Admin-only UI components
    auth/                 Login/signup forms
    cart/                 Cart UI
    checkout/             Checkout and payment form
    dashboard/            Customer dashboard components
    layout/               Header, footer, navigation, mega menu
    products/             Product grid, filters, cards, gallery
    ui/                   shadcn/ui base components (Button, Input, etc.)

  lib/
    actions/              Server Actions - all data fetching and mutations
      orders.ts
      products.ts
      stripe.ts
      reservations.ts
      profile.ts
      ...
    auth/
      auth-context.tsx    React Context provider for auth state
    stripe/
      client.ts           Stripe browser client (publishable key)
      config.ts           Stripe server client (secret key - server only)
    supabase/
      client.ts           Browser Supabase client
      server.ts           Server Supabase client (cookie-based auth)
      admin.ts            Service-role Supabase client (admin operations)
    types/                TypeScript type definitions
    utils/                Shared utility functions

  store/
    useCartStore.ts       Zustand cart store
    useFilterStore.ts     Zustand filter store

  database/
    schema/               SQL files - one per feature set
    seeds/                Seed data for development

  docs/                   This folder
```

---

## Layered Architecture

The system has four distinct layers. Each layer has a defined responsibility and communicates only with the layers adjacent to it.

```
+---------------------------+
|   UI Layer                |   React components (Server + Client)
|   app/ + components/      |   Renders pages, handles user interaction
+---------------------------+
            |
            | calls
            v
+---------------------------+
|   Action Layer            |   Server Actions (lib/actions/)
|   lib/actions/*.ts        |   All data fetching and mutations live here
+---------------------------+
            |
            | queries via Supabase client
            v
+---------------------------+
|   Database Layer          |   Supabase PostgreSQL
|   Supabase + RLS          |   RLS enforces access control at this level
+---------------------------+
            |
            | enforced by
            v
+---------------------------+
|   Auth Layer              |   Supabase Auth + Edge Middleware
|   middleware + cookies    |   Session validation before pages render
+---------------------------+
```

### UI Layer

Pages and components. Server Components run at request time on the server and can call Server Actions directly. Client Components run in the browser and can use Zustand stores, React hooks, and browser APIs.

**Rule:** Server Components never import from `store/` or use browser APIs. Client Components never import server-only modules (Stripe secret key, Supabase admin client).

### Action Layer

All database reads and writes go through `lib/actions/`. These are Next.js Server Actions - they run on the server regardless of where they are called from. This means:

- Secrets (Stripe secret key, Supabase service role key) never reach the browser
- Validation and business logic are co-located with data access
- No separate API routes needed for standard CRUD operations

### Database Layer

Supabase PostgreSQL. Row Level Security (RLS) is enabled on every table. Even if an Action had a bug that allowed an unintended query, RLS would block it at the database level.

### Auth Layer

Two enforcement points:

1. **Edge Middleware** (`src/app/proxy.ts`) - runs before any page renders. Checks the Supabase auth cookie and redirects unauthenticated users away from protected routes (`/checkout`, `/dashboard`, `/admin`).
2. **Server Actions** - use `supabase.auth.getUser()` (not `getSession()`) to verify the session server-side before any data operation. `getSession()` reads the client cookie without server verification; `getUser()` makes a network call to Supabase to confirm the token is valid.

---

## Server vs Client Components

The App Router defaults to Server Components. A component opts into client-side rendering with `'use client'` at the top of the file.

| When to use Server Component | When to use Client Component |
|---|---|
| Fetching data from the database | Using useState, useEffect, useRef |
| Rendering static or server-fetched content | Handling user events (onClick, onChange) |
| Keeping secrets out of the browser | Using Zustand stores |
| SEO-important content | Using browser APIs (localStorage, window) |
| Reducing client bundle size | Stripe Elements (must run in browser) |

### The boundary rule

Server Components can import and render Client Components. Client Components cannot import Server Components. When a Client Component needs data, it receives it as a prop from a parent Server Component - the server fetches, the client renders.

```
app/products/page.tsx          (Server Component)
    fetches products[] from Supabase
    passes products[] as a prop
        |
        v
components/products/filtered-product-list.tsx  (Client Component)
    receives products[] prop
    applies Zustand filter state client-side
    no server round-trip needed for filtering
```

---

## Database Schema

The database is split across SQL migration files in `src/database/schema/`, one per feature set.

### Core Tables

| Table | Purpose | Key Fields |
|---|---|---|
| `products` | Product catalog | `slug`, `price`, `sale_price`, `stock_quantity`, `in_stock`, `deleted_at` |
| `profiles` | User profile data (mirrors `auth.users`) | `id`, `full_name`, `phone`, `role`, `avatar_url` |
| `orders` | Customer orders | `order_number`, `status`, `stripe_payment_intent_id`, shipping address snapshot |
| `order_items` | Line items per order | `product_name`, `price` (snapshot at time of order), `quantity` |
| `addresses` | Saved customer addresses | `user_id`, full address fields |
| `reviews` | Product reviews | `product_id`, `user_id`, `rating`, `status` (pending/approved/rejected) |
| `services` | Bookable service types | `name`, `duration_minutes`, `price`, `category` |
| `appointments` | Service bookings | `service_id`, `user_id`, `scheduled_at`, `status` |
| `stock_reservations` | Checkout inventory holds | `product_id`, `quantity`, `reserved_by`, `expires_at` |
| `stock_adjustments` | Inventory audit log | `adjustment_type`, `quantity_change`, `previous_quantity`, `new_quantity` |
| `suppliers` | Supplier records | `name`, `contact_name`, `email` |
| `purchase_orders` | Stock replenishment orders | `supplier_id`, `status`, `expected_at` |
| `purchase_order_items` | Line items per PO | `product_id`, `quantity`, `cost_per_unit` |

### Soft Deletes

Products use `deleted_at` (nullable timestamp) rather than hard deletes. A deleted product is excluded from all public queries via `.is('deleted_at', null)` but remains in the database so historical orders still reference valid product data.

### Stock Integrity

Stock is never modified directly by application code. Two PostgreSQL functions handle all stock changes:

- **`reserve_stock()`** - called at checkout start. Acquires a `FOR UPDATE` row lock, calculates available stock as `stock_quantity - SUM(active reservations)`, and inserts a `stock_reservations` row. Raises an exception if stock is insufficient.
- **`reduce_stock()`** - called at order confirmation. Atomically decrements `stock_quantity` and writes an audit row to `stock_adjustments`.

Both functions are `SECURITY DEFINER`, meaning they run with the database owner's permissions and bypass RLS - the controlled write path is the function itself, not the table.

### Row Level Security

RLS policies per table (representative examples):

| Table | Policy |
|---|---|
| `products` | Anyone can read active products; only service role can write |
| `orders` | Users can read/insert their own orders only (`user_id = auth.uid()`) |
| `order_items` | Readable via the parent order's RLS |
| `profiles` | Users can read and update their own profile only |
| `reviews` | Anyone can read approved reviews; users can write/edit their own |
| `appointments` | Users can read their own bookings; admin can read all |
| `stock_adjustments` | No public access; service role only |
| `stock_reservations` | No direct table access; all interaction via `reserve_stock()` RPC |

---

## Auth Architecture

Supabase Auth manages sessions via HTTP-only cookies. The flow at every page load:

```
Request arrives
    |
    +-- Edge Middleware
    |     reads auth cookie
    |     calls supabase.auth.getUser()
    |     if protected route + no session: redirect to /login
    |
    +-- Page renders
    |     AuthProvider mounts (root layout)
    |     calls supabase.auth.getSession() to hydrate client state
    |     onAuthStateChange listener watches for session changes
    |
    +-- Server Actions
          each action calls supabase.auth.getUser() independently
          does not trust the client-side session
```

Three Supabase clients are used in different contexts:

| Client | File | Used for |
|---|---|---|
| Browser client | `lib/supabase/client.ts` | Client Components, auth state changes |
| Server client | `lib/supabase/server.ts` | Server Components, Server Actions (reads auth cookie) |
| Admin client | `lib/supabase/admin.ts` | Service-role operations that bypass RLS (admin dashboard) |

---

## Security Layers Summary

| Threat | Mitigation |
|---|---|
| Unauthenticated access to protected pages | Edge Middleware redirects before page renders |
| Forged or expired session tokens | `getUser()` validates server-side on every Server Action |
| Cross-user data access | RLS policies enforce `user_id = auth.uid()` at DB level |
| Overselling (race condition) | `reserve_stock()` uses `FOR UPDATE` row lock |
| Payment without valid reservation | Stripe webhook checks active reservation before confirming order |
| Brute-force on auth endpoints | Upstash Redis rate limiting (requests per IP per window) |
| Card data exposure | Stripe Elements - card data goes directly to Stripe, never our server |
| Secret key exposure | Server-only modules never imported in Client Components |

---

## External Services

### Stripe

Two integration points:

1. **Stripe Elements** (browser) - renders the card input. Card data goes directly to Stripe servers; our application never sees raw card numbers.
2. **Stripe Webhook** (`src/app/api/webhooks/stripe/route.ts`) - Stripe calls this server-to-server on payment events. The webhook is the system of record for order confirmation, not the client-side callback. Each event is verified with the Stripe webhook secret and checked for idempotency before processing.

### Supabase Storage

Product images are stored in a Supabase Storage bucket. Public bucket URLs are stored in the `products.images` array field and served directly - no proxy needed.

### Upstash Redis

Rate limiting is applied at the Edge Middleware level using the `@upstash/ratelimit` library. Auth endpoints (login, signup, password reset) are limited per IP address to prevent brute-force and credential stuffing attacks.

### Google Places API

Called client-side from the checkout shipping form. The API key is restricted to the application domain and the Places API only. Autocomplete suggestions populate the address fields; the user confirms the selection before proceeding.

---

## Further Reading

- [DATA_FLOW.md](./DATA_FLOW.md) - Request-level traces for the key user journeys (browsing, cart, checkout, auth)
- [STATE_MANAGEMENT.md](./STATE_MANAGEMENT.md) - Deep dive into Zustand stores, React Context, and URL params
- [DESIGN_DOC.md](./DESIGN_DOC.md) - Design system, color tokens, component patterns, responsive breakpoints
- [PRD.md](./PRD.md) - Full product requirements, feature list by phase, non-functional requirements
