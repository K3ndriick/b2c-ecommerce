# PowerProShop - System Architecture

**Project:** PowerProShop E-Commerce Platform
**Stack:** Next.js 16 · React 19 · TypeScript · Supabase · Stripe · Zustand · Tailwind CSS

> **High-level overview.** This is the top-level summary of the system. For the detailed architecture (codebase structure, DB schema, RLS/security layers) see [src/docs/ARCHITECTURE.md](src/docs/ARCHITECTURE.md); for Mermaid topology and checkout diagrams see [src/docs/DIAGRAMS.md](src/docs/DIAGRAMS.md).

---

## System Layers

The application is split into four distinct layers. Data flows top-to-bottom; events flow bottom-to-top.

```
┌─────────────────────────────────────────────────────┐
│                   BROWSER (Client)                  │
│  Pages & Layouts · Components · Zustand Stores      │
└────────────────────────┬────────────────────────────┘
                         │  React Server Components /
                         │  Server Actions (no HTTP)
┌────────────────────────▼────────────────────────────┐
│               NEXT.JS SERVER (Edge / Node)          │
│  Server Actions · Middleware · Route Handlers       │
└────────────────────────┬────────────────────────────┘
                         │  Supabase JS SDK
┌────────────────────────▼────────────────────────────┐
│                  SUPABASE (Backend)                 │
│  PostgreSQL · Auth · RLS Policies · DB Functions    │
└────────────────────────┬────────────────────────────┘
                         │  Stripe Node SDK
┌────────────────────────▼────────────────────────────┐
│                    STRIPE (Payments)                │
│  PaymentIntents · Customer data                     │
└─────────────────────────────────────────────────────┘
```

---

## Directory Map

```
src/
├── app/                      # Next.js App Router - pages and routes
│   ├── (auth)/               # Route group: login, signup, forgot-password
│   ├── auth/                 # OAuth callback handler + error page
│   ├── cart/                 # Shopping cart page
│   ├── checkout/             # Checkout form + success confirmation
│   ├── dashboard/            # Authenticated user dashboard
│   ├── orders/               # Order history and order detail
│   ├── products/             # Product listing and product detail ([slug])
│   ├── layout.tsx            # Root layout - wraps entire app
│   └── page.tsx              # Homepage
│
├── components/               # React UI components (no data fetching)
│   ├── auth/                 # Login, signup, reset forms · UserMenu
│   ├── cart/                 # CartItem, CartSummary, QuantityControl
│   ├── checkout/             # PaymentForm, ShippingAddressForm, OrderSummary
│   ├── dashboard/            # DashboardSidebar
│   ├── layout/               # Header, Footer, Hero, mega-menu parts
│   ├── orders/               # OrderCard
│   ├── products/             # ProductCard, ProductFilters, ProductSort, etc.
│   └── ui/                   # shadcn/ui primitives (Button, Input, Badge, …)
│
├── lib/
│   ├── actions/              # Server Actions - the data access layer
│   │   ├── products.ts       # getProducts, getProductBySlug, getFeaturedProducts
│   │   ├── orders.ts         # createOrder, getUserOrders, getOrderById
│   │   ├── related-products.ts
│   │   └── stripe.ts         # createPaymentIntent (server-only Stripe call)
│   ├── auth/
│   │   └── auth-context.tsx  # AuthProvider + useAuth hook
│   ├── stripe/
│   │   ├── client.ts         # Stripe browser client (@stripe/stripe-js)
│   │   ├── server.ts         # Stripe Node SDK (secret key - server only)
│   │   └── config.ts         # Shared Stripe constants (currency, etc.)
│   ├── supabase/
│   │   ├── client.ts         # createBrowserClient - for Client Components
│   │   └── server.ts         # createServerClient - for Server Components / Actions
│   ├── types/                # TypeScript type definitions
│   │   ├── auth.ts           # Profile, AuthContextType, form types
│   │   ├── cart.ts           # CartItem, CartSummary
│   │   ├── order.ts          # Order, OrderWithItems, ShippingAddress
│   │   ├── products.ts       # Product, ProductFilters, ProductSortOption
│   │   └── index.ts          # Re-exports everything from one place
│   └── utils/
│       ├── utils.ts          # cn() - Tailwind class merging utility
│       ├── product-helpers.ts # calculateProductPricing, getStockStatus, formatPrice
│       └── breadcrumbs.ts    # generateProductBreadcrumbs helpers
│
├── store/                    # Zustand client-side state
│   ├── useCartStore.ts       # Cart items + computed totals + localStorage persistence
│   └── useFilterStore.ts     # Product filters + sort + view mode + localStorage persistence
│
├── database/
│   ├── schema/               # SQL table definitions (run once in Supabase)
│   └── seeds/                # Sample product data
│
└── data/
    └── navigation.ts         # Static site navigation structure
```

---

## Key Architectural Decisions

### Server Actions instead of API Routes

All data fetching and mutations use Next.js Server Actions (`'use server'`) rather than `app/api/` routes.

**Why:**
- Full TypeScript type safety across the server/client boundary - no JSON serialization
- Simpler code - components call functions directly, not `fetch()`
- Next.js caches and deduplicates them automatically
- Secret keys (Supabase service role, Stripe secret) stay on the server with zero extra work

```typescript
// Component calls a server function directly - no fetch(), no JSON
const products = await getProducts({ category: 'cardio' })
```

---

### Two Supabase Clients

Supabase needs different clients depending on where code runs:

| File                     | Used in                                       | Why                            |
|--------------------------|-----------------------------------------------|--------------------------------|
| `lib/supabase/client.ts` | Client Components, Zustand                    | Uses browser cookies for auth  |
| `lib/supabase/server.ts` | Server Components, Server Actions, Middleware | Reads cookies from the request |

Using the wrong one causes auth to silently fail (the session won't be found).

---

### Server Components vs Client Components

The rule used throughout this project:

| Scenario                              | Component type                                                            |
|---------------------------------------|---------------------------------------------------------------------------|
| Fetching data, no interactivity       | Server Component (default)                                                |
| Interactive UI (clicks, forms, hooks) | Client Component (`'use client'`)                                         |
| Both needed                           | Server Component parent passes data as props to Client Component children |

The products listing page is the clearest example: `app/products/page.tsx` is a Server Component that fetches all products, then passes them to `FilteredProductList` (a Client Component) which handles client-side filtering and sorting via Zustand.

---

### State Management Split

Three different mechanisms manage state, each for a specific purpose:

| Mechanism                       | What it manages                       | Why                                                              |
|---------------------------------|---------------------------------------|------------------------------------------------------------------|
| **Zustand** (`useCartStore`)    | Cart items, quantities, totals        | Needs localStorage persistence across pages                      |
| **Zustand** (`useFilterStore`)  | Product filters, sort, view mode      | Needs localStorage persistence across pages                      |
| **AuthContext** (React Context) | User, profile, session, loading       | Auth state is app-wide; Supabase handles persistence via cookies |
| **URL search params**           | Active category/search filter for SSR | Makes filtered pages shareable/bookmarkable                      |

See [STATE_MANAGEMENT.md](src/docs/STATE_MANAGEMENT.md) for detail.

---

### Row Level Security (RLS)

Supabase enforces data access rules at the database level. This means even if application code has a bug, users cannot read or modify other users' data. Key policies:

- `profiles` - users can only SELECT/UPDATE their own row
- `orders` - users can only SELECT their own orders
- `products` - public SELECT for non-deleted rows; only service role can INSERT/UPDATE/DELETE

---

## Database Tables

```
auth.users          (managed by Supabase Auth)
    │
    ├── public.profiles         id → auth.users(id)
    │
    └── public.orders           user_id → auth.users(id)
            │
            └── public.order_items    order_id → orders(id)
                                      product_id → products(id)

public.products     (standalone - no FK to auth)
```

---

## Authentication Flow Summary

```
User submits login form
    → LoginForm calls signIn() from useAuth()
    → signIn() calls supabase.auth.signInWithPassword()
    → Supabase sets an auth cookie in the browser
    → onAuthStateChange() listener fires in AuthContext
    → AuthContext fetches the profile row and sets state
    → UserMenu in Header re-renders showing the user's name
```

Protected routes (`/checkout`, `/profile`, `/orders`, `/dashboard`) are guarded by `middleware.ts`, which reads the auth cookie on every request and redirects to `/login` if no session exists.

See [DATA_FLOW.md](src/docs/DATA_FLOW.md) for the full checkout flow.

---

## Further Reading

- [DATA_FLOW.md](src/docs/DATA_FLOW.md) - step-by-step flows for key user journeys
- [STATE_MANAGEMENT.md](src/docs/STATE_MANAGEMENT.md) - deep dive on Zustand stores and AuthContext
- Phase guides in the project root - how each feature was built
