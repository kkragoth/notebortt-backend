import Stripe from 'stripe';
import { createBillingCheckoutDomain } from '../billing/checkout-domain.js';
import { createBillingCustomerDomain } from '../billing/customer-domain.js';
import { createBillingProfileDomain } from '../billing/profile-domain.js';
import { createBillingSubscriptionDomain } from '../billing/subscription-domain.js';
import { createBillingWebhookDomain } from '../billing/webhook-domain.js';
import type { Database } from '@/platform/db/client.js';
import type { BoardService } from '@/modules/boards/index.js';
import type { UserService } from '@/modules/users/index.js';
import type { WorkspaceService } from '@/modules/workspaces/index.js';
import type {BillingCheckoutRequest, BillingProfile, BillingServiceConfig} from '../billing/shared.js';

export type { BillingCheckoutRequest, BillingPlan, BillingProfile } from '../billing/shared.js';

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
    );

    const stripe = isStripeConfigured
        ? new Stripe(config.stripeSecretKey as string, {
            appInfo: { name: 'note-canva-backend', version: '1.0.0' },
            // Don't let a hung Stripe call pin an Express request forever.
            timeout: 10_000,
            maxNetworkRetries: 2,
        })
        : null;

    const customerDomain = createBillingCustomerDomain({ db, stripe });
    const subscriptionDomain = createBillingSubscriptionDomain({
        config,
        db,
        upsertCustomerLink: customerDomain.upsertCustomerLink,
    });
    const profileDomain = createBillingProfileDomain({
        config,
        db,
        stripe,
        userService,
        workspaceService,
        boardService,
        findStripeCustomerByUser: customerDomain.findStripeCustomerByUser,
        upsertSubscription: subscriptionDomain.upsertSubscription,
    });
    const checkoutDomain = createBillingCheckoutDomain({
        config,
        stripe,
        userService,
        getOrCreateStripeCustomer: customerDomain.getOrCreateStripeCustomer,
    });
    const webhookDomain = createBillingWebhookDomain({
        db,
        stripe,
        stripeWebhookSecret: config.stripeWebhookSecret,
        upsertCustomerLink: customerDomain.upsertCustomerLink,
        upsertSubscription: subscriptionDomain.upsertSubscription,
        markSubscriptionCanceled: subscriptionDomain.markSubscriptionCanceled,
    });

    async function startCheckout(userId: string, request: BillingCheckoutRequest) {
        return checkoutDomain.startCheckout(userId, request, {
            startup: config.stripePriceStartup as string,
            business: config.stripePriceBusiness as string,
        });
    }

    return {
        fetchCurrentBillingProfile: profileDomain.fetchCurrentBillingProfile,
        startCheckout,
        openBillingPortal: checkoutDomain.openBillingPortal,
        handleWebhook: webhookDomain.handleWebhook,
    };
}

export type BillingService = ReturnType<typeof createBillingService>
