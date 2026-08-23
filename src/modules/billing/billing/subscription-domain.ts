import Stripe from 'stripe';
import {
    getPlanFromPriceId,
    getSubscriptionCurrentPeriodEnd,
    getSubscriptionOrganizationId,
    getSubscriptionUserId,
    toDate
  
} from '../billing/shared.js';
import type { Database } from '@/platform/db/client.js';
import type {BillingServiceConfig} from '../billing/shared.js';
import { billingSubscriptions } from '@/platform/db/schema.js';

interface SubscriptionDomainDeps {
  config: Pick<BillingServiceConfig, 'stripePriceStartup' | 'stripePriceBusiness'>
  db: Database
  upsertCustomerLink: (customerId: string, userId: string | null, organizationId: string | null, email: string | null) => Promise<void>
}

export function createBillingSubscriptionDomain(deps: SubscriptionDomainDeps) {
    const { config, db, upsertCustomerLink } = deps;

    async function upsertSubscription(subscription: Stripe.Subscription) {
        const priceId = subscription.items.data[0]?.price.id ?? null;
        const plan = getPlanFromPriceId(priceId, config);
        const userId = getSubscriptionUserId(subscription);
        const organizationId = getSubscriptionOrganizationId(subscription);

        await upsertCustomerLink(subscription.customer as string, userId, organizationId, null);

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
                raw: subscription,
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
                    raw: subscription,
                    updatedAt: new Date(),
                },
            });
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
                raw: subscription,
                updatedAt: new Date(),
            })
            .onConflictDoUpdate({
                target: billingSubscriptions.stripeSubscriptionId,
                set: {
                    status: subscription.status,
                    plan: 'free',
                    updatedAt: new Date(),
                    raw: subscription,
                },
            });
    }

    return {
        upsertSubscription,
        markSubscriptionCanceled,
    };
}
