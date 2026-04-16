import 'dotenv/config'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { stripe } from '@better-auth/stripe'
import Stripe from 'stripe'
import { createDb } from './src/db/client.js'
import { users, oauthAccounts, authSessions, authVerifications, authSubscriptions } from './src/db/schema.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for Better Auth config')
}

const db = createDb(databaseUrl)
const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder', {
  apiVersion: '2026-03-25.dahlia',
})

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET ?? 'replace-with-long-random-secret',
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000/api/auth',
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: users,
      account: oauthAccounts,
      session: authSessions,
      verification: authVerifications,
      subscription: authSubscriptions,
    },
  }),
  advanced: {
    database: {
      generateId: 'uuid',
    },
  },
  user: {
    fields: {
      image: 'avatarUrl',
      emailVerified: 'emailVerified',
    },
  },
  account: {
    fields: {
      accountId: 'providerId',
      providerId: 'provider',
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? 'replace_me',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? 'replace_me',
    },
  },
  plugins: [
    stripe({
      stripeClient,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_placeholder',
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        plans: [
          { name: 'startup', priceId: process.env.STRIPE_PRICE_STARTUP ?? 'price_startup_placeholder' },
          { name: 'business', priceId: process.env.STRIPE_PRICE_BUSINESS ?? 'price_business_placeholder' },
        ],
      },
    }),
  ],
})
