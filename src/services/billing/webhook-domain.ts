import Stripe from 'stripe';
import type { Database } from '@/db/client.js';
import { billingWebhookEvents } from '@/db/schema.js';

interface WebhookDomainDeps {
  db: Database
  stripe: Stripe | null
  stripeWebhookSecret: string | null | undefined
  upsertCustomerLink: (customerId: string, userId: string | null, organizationId: string | null, email: string | null) => Promise<void>
  upsertSubscription: (subscription: Stripe.Subscription) => Promise<void>
  markSubscriptionCanceled: (subscription: Stripe.Subscription) => Promise<void>
}

export function createBillingWebhookDomain(deps: WebhookDomainDeps) {
    const {
        db,
        stripe,
        stripeWebhookSecret,
        upsertCustomerLink,
        upsertSubscription,
        markSubscriptionCanceled,
    } = deps;

    async function handleWebhook(rawBody: Buffer, signature: string | null | undefined) {
        if (!stripe || !stripeWebhookSecret) {
            throw new Error('Stripe webhook is not configured');
        }
        if (!signature) {
            throw new Error('Missing Stripe signature');
        }

        const event = stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret);
        const insertResult = await db
            .insert(billingWebhookEvents)
            .values({
                stripeEventId: event.id,
                eventType: event.type,
                raw: event,
            })
            .onConflictDoNothing({ target: billingWebhookEvents.stripeEventId })
            .returning({ id: billingWebhookEvents.id });

        if (insertResult.length === 0) {
            return { duplicate: true };
        }

        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const customerId = typeof session.customer === 'string' ? session.customer : null;
                const userId = session.metadata?.userId ?? null;
                const organizationId = session.metadata?.organizationId ?? session.metadata?.organization_id ?? null;
                if (customerId) {
                    await upsertCustomerLink(customerId, userId, organizationId, session.customer_details?.email ?? null);
                }
                break;
            }
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
            case 'customer.subscription.resumed':
            case 'customer.subscription.trial_will_end': {
                const subscription = event.data.object;
                await upsertSubscription(subscription);
                break;
            }
            case 'customer.subscription.deleted':
            case 'customer.subscription.paused': {
                const subscription = event.data.object;
                await markSubscriptionCanceled(subscription);
                break;
            }
            default:
                break;
        }

        return { duplicate: false };
    }

    return {
        handleWebhook,
    };
}
