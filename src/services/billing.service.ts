import { desc, eq } from 'drizzle-orm'
import Stripe from 'stripe'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/client.js'
import { billingCustomerLinks, billingSubscriptions, billingWebhookEvents } from '../db/schema.js'
import type { BoardService } from './board.service.js'
import type { UserService } from './user.service.js'
import type { WorkspaceService } from './workspace.service.js'

export type BillingPlan = 'free' | 'startup' | 'business' | 'trial' | 'dev'

export interface BillingProfile {
  currentPlan: BillingPlan
  trialExpirationTimestamp: number | null
  usageCounters: {
    workspacesUsed: number
    boardsInCurrentWorkspace: number
    largestBoardElements: number
    realtimeUsersCurrentBoard: number
  }
  limits: {
    maxWorkspaces: number | null
    maxBoardsPerWorkspace: number | null
    maxElementsPerBoard: number | null
    maxRealtimeUsers: number | null
  }
  flags: {
    isDevOverride: boolean
    isTrialActive: boolean
  }
}

export interface BillingCheckoutRequest {
  plan: BillingPlan
  successUrl?: string
  cancelUrl?: string
}

const PLAN_LIMITS: Record<BillingPlan, BillingProfile['limits']> = {
  free: { maxWorkspaces: 1, maxBoardsPerWorkspace: 5, maxElementsPerBoard: 500, maxRealtimeUsers: 1 },
  startup: { maxWorkspaces: 5, maxBoardsPerWorkspace: 25, maxElementsPerBoard: 2500, maxRealtimeUsers: 5 },
  business: { maxWorkspaces: 25, maxBoardsPerWorkspace: 100, maxElementsPerBoard: 10000, maxRealtimeUsers: 20 },
  trial: { maxWorkspaces: 3, maxBoardsPerWorkspace: 10, maxElementsPerBoard: 1500, maxRealtimeUsers: 3 },
  dev: { maxWorkspaces: null, maxBoardsPerWorkspace: null, maxElementsPerBoard: null, maxRealtimeUsers: null },
}

function getPlanFromPriceId(
  priceId: string | null | undefined,
  config: Pick<AppConfig, 'stripePriceStartup' | 'stripePriceBusiness'>,
): BillingPlan {
  if (!priceId) {
    return 'free'
  }
  if (config.stripePriceBusiness && priceId === config.stripePriceBusiness) {
    return 'business'
  }
  if (config.stripePriceStartup && priceId === config.stripePriceStartup) {
    return 'startup'
  }

  return 'free'
}

function getPlanFromSubscriptionRecord(record: { plan: string; status: string }): BillingPlan {
  if (record.status === 'trialing') {
    return 'trial'
  }
  if (record.plan === 'business') {
    return 'business'
  }
  if (record.plan === 'startup') {
    return 'startup'
  }

  return 'free'
}

function pickActiveSubscription(subscriptions: Stripe.Subscription[]): Stripe.Subscription | null {
  const activeStates = new Set<Stripe.Subscription.Status>(['trialing', 'active', 'past_due', 'unpaid'])
  const candidates = subscriptions
    .filter((subscription) => activeStates.has(subscription.status))
    .sort((a, b) => b.created - a.created)

  return candidates[0] ?? null
}

function getSubscriptionUserId(subscription: Stripe.Subscription): string | null {
  return subscription.metadata.userId ?? null
}

function getSubscriptionOrganizationId(subscription: Stripe.Subscription): string | null {
  // Keep organization linkage ready for Better Auth organization + stripe plugin migration.
  return subscription.metadata.organizationId
    ?? subscription.metadata.organization_id
    ?? null
}

function toDate(value: number | null): Date | null {
  return value ? new Date(value * 1000) : null
}

function getSubscriptionCurrentPeriodEnd(subscription: Stripe.Subscription): number | null {
  const itemEnds = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === 'number')

  if (itemEnds.length === 0) {
    return null
  }

  return Math.max(...itemEnds)
}

export function createBillingService(
  config: Pick<AppConfig,
    | 'nodeEnv'
    | 'corsOrigin'
    | 'stripeBillingEnabled'
    | 'stripeSecretKey'
    | 'stripePriceStartup'
    | 'stripePriceBusiness'
    | 'stripeCheckoutSuccessUrl'
    | 'stripeCheckoutCancelUrl'
    | 'stripePortalReturnUrl'
    | 'stripeWebhookSecret'>,
  db: Database,
  userService: UserService,
  workspaceService: WorkspaceService,
  boardService: BoardService,
) {
  const isStripeConfigured = Boolean(
    config.stripeBillingEnabled
    && config.stripeSecretKey
    && config.stripePriceStartup
    && config.stripePriceBusiness,
  )

  const stripe = isStripeConfigured
    ? new Stripe(config.stripeSecretKey as string, { appInfo: { name: 'note-canva-backend', version: '1.0.0' } })
    : null

  async function upsertCustomerLink(customerId: string, userId: string | null, organizationId: string | null, email: string | null) {
    await db
      .insert(billingCustomerLinks)
      .values({
        stripeCustomerId: customerId,
        userId,
        organizationId,
        email,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: billingCustomerLinks.stripeCustomerId,
        set: {
          userId,
          organizationId,
          email,
          updatedAt: new Date(),
        },
      })
  }

  async function upsertSubscription(subscription: Stripe.Subscription) {
    const priceId = subscription.items.data[0]?.price.id ?? null
    const plan = getPlanFromPriceId(priceId, config)
    const userId = getSubscriptionUserId(subscription)
    const organizationId = getSubscriptionOrganizationId(subscription)

    await upsertCustomerLink(subscription.customer as string, userId, organizationId, null)

    await db
      .insert(billingSubscriptions)
      .values({
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer as string,
        organizationId,
        userId,
        status: subscription.status,
        plan,
        priceId,
        trialEnd: toDate(subscription.trial_end),
        currentPeriodEnd: toDate(getSubscriptionCurrentPeriodEnd(subscription)),
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        raw: subscription as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: billingSubscriptions.stripeSubscriptionId,
        set: {
          stripeCustomerId: subscription.customer as string,
          organizationId,
          userId,
          status: subscription.status,
          plan,
          priceId,
          trialEnd: toDate(subscription.trial_end),
          currentPeriodEnd: toDate(getSubscriptionCurrentPeriodEnd(subscription)),
          cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
          raw: subscription as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        },
      })
  }

  async function markSubscriptionCanceled(subscription: Stripe.Subscription) {
    await db
      .insert(billingSubscriptions)
      .values({
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer as string,
        organizationId: getSubscriptionOrganizationId(subscription),
        userId: getSubscriptionUserId(subscription),
        status: subscription.status,
        plan: 'free',
        priceId: subscription.items.data[0]?.price.id ?? null,
        trialEnd: toDate(subscription.trial_end),
        currentPeriodEnd: toDate(getSubscriptionCurrentPeriodEnd(subscription)),
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        raw: subscription as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: billingSubscriptions.stripeSubscriptionId,
        set: {
          status: subscription.status,
          plan: 'free',
          updatedAt: new Date(),
          raw: subscription as unknown as Record<string, unknown>,
        },
      })
  }

  async function findStripeCustomerByUser(userId: string, email: string): Promise<Stripe.Customer | null> {
    if (!stripe) {
      return null
    }

    const existingLink = await db
      .select({ stripeCustomerId: billingCustomerLinks.stripeCustomerId })
      .from(billingCustomerLinks)
      .where(eq(billingCustomerLinks.userId, userId))
      .limit(1)

    if (existingLink[0]) {
      const customer = await stripe.customers.retrieve(existingLink[0].stripeCustomerId)
      if (!('deleted' in customer)) {
        return customer
      }
    }

    const customerList = await stripe.customers.list({ email, limit: 20 })
    const customer = customerList.data.find((item) => item.metadata?.userId === userId) ?? customerList.data[0]
    if (customer) {
      await upsertCustomerLink(customer.id, userId, null, customer.email ?? null)
    }

    return customer ?? null
  }

  async function getOrCreateStripeCustomer(userId: string, email: string, name: string): Promise<Stripe.Customer> {
    if (!stripe) {
      throw new Error('Stripe billing is not configured')
    }

    const existing = await findStripeCustomerByUser(userId, email)
    if (existing) {
      return existing
    }

    const customer = await stripe.customers.create({
      email,
      name,
      metadata: { userId },
    })
    await upsertCustomerLink(customer.id, userId, null, customer.email ?? email)
    return customer
  }

  async function getUsageCounters(userId: string): Promise<BillingProfile['usageCounters']> {
    const [workspaces, boards] = await Promise.all([
      workspaceService.getWorkspacesForUser(userId),
      boardService.listAccessibleBoards(userId),
    ])

    const boardsByWorkspace = new Map<string, number>()
    for (const board of boards) {
      boardsByWorkspace.set(board.workspaceId, (boardsByWorkspace.get(board.workspaceId) ?? 0) + 1)
    }

    return {
      workspacesUsed: workspaces.length,
      boardsInCurrentWorkspace: Math.max(0, ...boardsByWorkspace.values()),
      largestBoardElements: 0,
      realtimeUsersCurrentBoard: 1,
    }
  }

  async function fetchCurrentBillingProfile(userId: string): Promise<BillingProfile> {
    const user = await userService.getUserById(userId)
    if (!user) {
      throw new Error('User not found')
    }

    const usageCounters = await getUsageCounters(userId)

    if (!stripe) {
      const isDevOverride = config.nodeEnv !== 'production'
      const currentPlan: BillingPlan = isDevOverride ? 'dev' : 'free'

      return {
        currentPlan,
        trialExpirationTimestamp: null,
        usageCounters,
        limits: PLAN_LIMITS[currentPlan],
        flags: {
          isDevOverride,
          isTrialActive: false,
        },
      }
    }

    const subscriptionRows = await db
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.userId, userId))
      .orderBy(desc(billingSubscriptions.updatedAt))
      .limit(1)

    const storedSubscription = subscriptionRows[0]
    if (storedSubscription && ['trialing', 'active', 'past_due', 'unpaid'].includes(storedSubscription.status)) {
      const plan = getPlanFromSubscriptionRecord(storedSubscription)
      const trialExpirationTimestamp = storedSubscription.trialEnd ? new Date(storedSubscription.trialEnd).getTime() : null

      return {
        currentPlan: plan,
        trialExpirationTimestamp,
        usageCounters,
        limits: PLAN_LIMITS[plan],
        flags: {
          isDevOverride: false,
          isTrialActive: plan === 'trial' && Boolean(trialExpirationTimestamp && trialExpirationTimestamp > Date.now()),
        },
      }
    }

    const customer = await findStripeCustomerByUser(user.id, user.email)
    if (!customer) {
      return {
        currentPlan: 'free',
        trialExpirationTimestamp: null,
        usageCounters,
        limits: PLAN_LIMITS.free,
        flags: {
          isDevOverride: false,
          isTrialActive: false,
        },
      }
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 20,
      expand: ['data.items.data.price'],
    })
    const activeSubscription = pickActiveSubscription(subscriptions.data)

    if (!activeSubscription) {
      return {
        currentPlan: 'free',
        trialExpirationTimestamp: null,
        usageCounters,
        limits: PLAN_LIMITS.free,
        flags: {
          isDevOverride: false,
          isTrialActive: false,
        },
      }
    }

    await upsertSubscription(activeSubscription)
    const plan = activeSubscription.status === 'trialing'
      ? 'trial'
      : getPlanFromPriceId(activeSubscription.items.data[0]?.price.id, config)
    const trialExpirationTimestamp = activeSubscription.trial_end ? activeSubscription.trial_end * 1000 : null

    return {
      currentPlan: plan,
      trialExpirationTimestamp,
      usageCounters,
      limits: PLAN_LIMITS[plan],
      flags: {
        isDevOverride: false,
        isTrialActive: plan === 'trial' && Boolean(trialExpirationTimestamp && trialExpirationTimestamp > Date.now()),
      },
    }
  }

  async function startCheckout(userId: string, request: BillingCheckoutRequest) {
    if (!stripe) {
      throw new Error('Stripe billing is not configured')
    }

    if (request.plan !== 'startup' && request.plan !== 'business') {
      throw new Error('Checkout is only available for paid plans')
    }

    const user = await userService.getUserById(userId)
    if (!user) {
      throw new Error('User not found')
    }

    const customer = await getOrCreateStripeCustomer(user.id, user.email, user.name)
    const priceId = request.plan === 'startup'
      ? (config.stripePriceStartup as string)
      : (config.stripePriceBusiness as string)

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: request.successUrl ?? config.stripeCheckoutSuccessUrl ?? `${config.corsOrigin}/profile/billing`,
      cancel_url: request.cancelUrl ?? config.stripeCheckoutCancelUrl ?? `${config.corsOrigin}/profile/billing`,
      allow_promotion_codes: true,
      client_reference_id: user.id,
      metadata: {
        userId: user.id,
        plan: request.plan,
      },
    })

    if (!session.url) {
      throw new Error('Stripe checkout URL missing from session')
    }

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
      plan: request.plan,
    }
  }

  async function openBillingPortal(userId: string, returnUrl?: string) {
    if (!stripe) {
      throw new Error('Stripe billing is not configured')
    }

    const user = await userService.getUserById(userId)
    if (!user) {
      throw new Error('User not found')
    }

    const customer = await getOrCreateStripeCustomer(user.id, user.email, user.name)
    const resolvedReturnUrl = returnUrl ?? config.stripePortalReturnUrl ?? `${config.corsOrigin}/profile/billing`
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: resolvedReturnUrl,
    })

    return {
      portalUrl: session.url,
      returnUrl: resolvedReturnUrl,
    }
  }

  async function handleWebhook(rawBody: Buffer, signature: string | null | undefined) {
    if (!stripe || !config.stripeWebhookSecret) {
      throw new Error('Stripe webhook is not configured')
    }
    if (!signature) {
      throw new Error('Missing Stripe signature')
    }

    const event = stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret)
    const insertResult = await db
      .insert(billingWebhookEvents)
      .values({
        stripeEventId: event.id,
        eventType: event.type,
        raw: event as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing({ target: billingWebhookEvents.stripeEventId })
      .returning({ id: billingWebhookEvents.id })

    if (insertResult.length === 0) {
      return { duplicate: true }
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const customerId = typeof session.customer === 'string' ? session.customer : null
        const userId = session.metadata?.userId ?? null
        const organizationId = session.metadata?.organizationId ?? session.metadata?.organization_id ?? null
        if (customerId) {
          await upsertCustomerLink(customerId, userId, organizationId, session.customer_details?.email ?? null)
        }
        break
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.resumed':
      case 'customer.subscription.trial_will_end': {
        const subscription = event.data.object as Stripe.Subscription
        await upsertSubscription(subscription)
        break
      }
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused': {
        const subscription = event.data.object as Stripe.Subscription
        await markSubscriptionCanceled(subscription)
        break
      }
      default:
        break
    }

    return { duplicate: false }
  }

  return {
    fetchCurrentBillingProfile,
    startCheckout,
    openBillingPortal,
    handleWebhook,
  }
}

export type BillingService = ReturnType<typeof createBillingService>
