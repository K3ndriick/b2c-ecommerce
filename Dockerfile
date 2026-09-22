# syntax=docker/dockerfile:1

# ============================================================
# Stage 1: deps. Install dependencies only.
# ============================================================
FROM node:24-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy ONLY the manifest files first (see "layer caching" below)
COPY package.json package-lock.json ./
RUN npm ci

# ============================================================
# Stage 2: builder. Compile the app.
# ============================================================
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the JS bundle at BUILD time,
# so they must exist here. They are public by design (they ship to the browser).
# NEVER add server secrets (STRIPE_SECRET_KEY, SERVICE_ROLE_KEY) as ARGs.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_GOOGLE_PLACES_API_KEY
ARG NEXT_PUBLIC_SITE_URL

ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY \
  NEXT_PUBLIC_GOOGLE_PLACES_API_KEY=$NEXT_PUBLIC_GOOGLE_PLACES_API_KEY \
  NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
  NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ============================================================
# Stage 3: runner. The only stage that becomes the final image.
# ============================================================
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3000 \
  HOSTNAME=0.0.0.0

# Run as an unprivileged user, not root
RUN addgroup --system --gid 1001 nodejs \
&& adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]