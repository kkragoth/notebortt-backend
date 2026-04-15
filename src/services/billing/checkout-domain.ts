import Stripe from 'stripe'
import type { UserService } from '../user.service.js'
import type { BillingCheckoutRequest, BillingServiceConfig } from './shared.js'

interface CheckoutDomainDeps {
  config: Pick<BillingServiceConfig,
    | 'corsOrigin'
    | 'stripeCheckoutSuccessUrl'
    | 'stripeCheckoutCancelUrl'
    | 'stripePortalReturnUrl'>
  stripe: Stripe | null
  userService: UserService
  getOrCreateStripeCustomer: (userId: string, email: string, name: string) => Promise<Stripe.Customer>
}

export function createBillingCheckoutDomain(deps: CheckoutDomainDeps) {
  const { config, stripe, userService, getOrCreateStripeCustomer } = deps

  async function startCheckout(userId: string, request: BillingCheckoutRequest, prices: { startup: string; business: string }) {
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
    const priceId = request.plan === 'startup' ? prices.startup : prices.business

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

  return {
    startCheckout,
    openBillingPortal,
  }
}
