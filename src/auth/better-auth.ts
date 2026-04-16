import { betterAuth } from 'better-auth'
import { toNodeHandler } from 'better-auth/node'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { stripe } from '@better-auth/stripe'
import Stripe from 'stripe'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/client.js'
import { users, oauthAccounts, authSessions, authVerifications, authSubscriptions, workspaceMembers, workspaces } from '../db/schema.js'

function buildStripePlugin(config: AppConfig) {
  if (!config.stripeBillingEnabled || !config.stripeSecretKey || !config.stripeWebhookSecret) {
    return null
  }

  const stripeClient = new Stripe(config.stripeSecretKey, { apiVersion: '2026-03-25.dahlia' })

  const plans: Array<{ name: string; priceId: string }> = []
  if (config.stripePriceStartup) {
    plans.push({ name: 'startup', priceId: config.stripePriceStartup })
  }
  if (config.stripePriceBusiness) {
    plans.push({ name: 'business', priceId: config.stripePriceBusiness })
  }

  return stripe({
    stripeClient,
    stripeWebhookSecret: config.stripeWebhookSecret,
    createCustomerOnSignUp: true,
    subscription: {
      enabled: plans.length > 0,
      plans,
    },
  })
}

export type BetterAuthSessionResolver = (headers: Headers) => Promise<{ userId: string } | null>

export function createBetterAuthBridge(config: AppConfig, db: Database) {
  if (!config.betterAuthSecret || !config.betterAuthUrl) {
    return null
  }

  const stripePlugin = buildStripePlugin(config)
  const trustedOrigins = config.corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)

  const auth = betterAuth({
    secret: config.betterAuthSecret,
    baseURL: config.betterAuthUrl,
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
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
      },
    },
    trustedOrigins,
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const existingWorkspace = await db
              .select({ workspaceId: workspaceMembers.workspaceId })
              .from(workspaceMembers)
              .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.role, 'owner')))
              .limit(1)

            if (existingWorkspace.length > 0) {
              return
            }

            await db.transaction(async (tx) => {
              const [newWorkspace] = await tx
                .insert(workspaces)
                .values({ name: 'Personal Workspace', ownerId: user.id })
                .returning()

              await tx.insert(workspaceMembers).values({
                workspaceId: newWorkspace.id,
                userId: user.id,
                role: 'owner',
              })
            })
          },
        },
      },
    },
    plugins: stripePlugin ? [stripePlugin] : [],
  })

  return {
    handler: toNodeHandler(auth),
    resolveSession: (headers: Headers) =>
      auth.api.getSession({ headers }).then((session) => (session ? { userId: session.user.id } : null)),
  }
}
