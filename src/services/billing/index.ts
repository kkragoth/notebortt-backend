import Stripe from 'stripe'
import type { Database } from '../../db/client.js'
import type { BoardService } from '../board.service.js'
import type { UserService } from '../user.service.js'
import type { WorkspaceService } from '../workspace.service.js'
import { createBillingCheckoutDomain } from './checkout-domain.js'
import { createBillingCustomerDomain } from './customer-domain.js'
import { createBillingProfileDomain } from './profile-domain.js'
import {
  type BillingCheckoutRequest,
  type BillingProfile,
  type BillingServiceConfig,
} from './shared.js'
import { createBillingSubscriptionDomain } from './subscription-domain.js'
import { createBillingWebhookDomain } from './webhook-domain.js'

export type { BillingCheckoutRequest, BillingPlan, BillingProfile } from './shared.js'

export function createBillingService(
  config: BillingServiceConfig,
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

  const customerDomain = createBillingCustomerDomain({ db, stripe })
  const subscriptionDomain = createBillingSubscriptionDomain({
    config,
    db,
    upsertCustomerLink: customerDomain.upsertCustomerLink,
  })
  const profileDomain = createBillingProfileDomain({
    config,
    db,
    stripe,
    userService,
    workspaceService,
    boardService,
    findStripeCustomerByUser: customerDomain.findStripeCustomerByUser,
    upsertSubscription: subscriptionDomain.upsertSubscription,
  })
  const checkoutDomain = createBillingCheckoutDomain({
    config,
    stripe,
    userService,
    getOrCreateStripeCustomer: customerDomain.getOrCreateStripeCustomer,
  })
  const webhookDomain = createBillingWebhookDomain({
    db,
    stripe,
    stripeWebhookSecret: config.stripeWebhookSecret,
    upsertCustomerLink: customerDomain.upsertCustomerLink,
    upsertSubscription: subscriptionDomain.upsertSubscription,
    markSubscriptionCanceled: subscriptionDomain.markSubscriptionCanceled,
  })

  async function startCheckout(userId: string, request: BillingCheckoutRequest) {
    return checkoutDomain.startCheckout(userId, request, {
      startup: config.stripePriceStartup as string,
      business: config.stripePriceBusiness as string,
    })
  }

  return {
    fetchCurrentBillingProfile: profileDomain.fetchCurrentBillingProfile as (userId: string) => Promise<BillingProfile>,
    startCheckout,
    openBillingPortal: checkoutDomain.openBillingPortal,
    handleWebhook: webhookDomain.handleWebhook,
  }
}

export type BillingService = ReturnType<typeof createBillingService>
