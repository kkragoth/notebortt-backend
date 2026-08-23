import Stripe from 'stripe';
import type { AppConfig } from '@/shared/config.js';

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

export type BillingServiceConfig = Pick<AppConfig,
  | 'nodeEnv'
  | 'corsOrigin'
  | 'stripeBillingEnabled'
  | 'stripeSecretKey'
  | 'stripePriceStartup'
  | 'stripePriceBusiness'
  | 'stripeCheckoutSuccessUrl'
  | 'stripeCheckoutCancelUrl'
  | 'stripePortalReturnUrl'
  | 'stripeWebhookSecret'>

export const PLAN_LIMITS: Record<BillingPlan, BillingProfile['limits']> = {
    free: { maxWorkspaces: 1, maxBoardsPerWorkspace: 5, maxElementsPerBoard: 500, maxRealtimeUsers: 1 },
    startup: { maxWorkspaces: 5, maxBoardsPerWorkspace: 25, maxElementsPerBoard: 2500, maxRealtimeUsers: 5 },
    business: { maxWorkspaces: 25, maxBoardsPerWorkspace: 100, maxElementsPerBoard: 10000, maxRealtimeUsers: 20 },
    trial: { maxWorkspaces: 3, maxBoardsPerWorkspace: 10, maxElementsPerBoard: 1500, maxRealtimeUsers: 3 },
    dev: { maxWorkspaces: null, maxBoardsPerWorkspace: null, maxElementsPerBoard: null, maxRealtimeUsers: null },
};

export function getPlanFromPriceId(
    priceId: string | null | undefined,
    config: Pick<BillingServiceConfig, 'stripePriceStartup' | 'stripePriceBusiness'>,
): BillingPlan {
    if (!priceId) {
        return 'free';
    }
    if (config.stripePriceBusiness && priceId === config.stripePriceBusiness) {
        return 'business';
    }
    if (config.stripePriceStartup && priceId === config.stripePriceStartup) {
        return 'startup';
    }

    return 'free';
}

export function getPlanFromSubscriptionRecord(record: { plan: string; status: string }): BillingPlan {
    if (record.status === 'trialing') {
        return 'trial';
    }
    if (record.plan === 'business') {
        return 'business';
    }
    if (record.plan === 'startup') {
        return 'startup';
    }

    return 'free';
}

export function pickActiveSubscription(subscriptions: Stripe.Subscription[]): Stripe.Subscription | null {
    const activeStates = new Set<Stripe.Subscription.Status>(['trialing', 'active', 'past_due', 'unpaid']);
    const candidates = subscriptions
        .filter((subscription) => activeStates.has(subscription.status))
        .sort((a, b) => b.created - a.created);

    return candidates[0] ?? null;
}

export function getSubscriptionUserId(subscription: Stripe.Subscription): string | null {
    return subscription.metadata.userId ?? null;
}

export function getSubscriptionOrganizationId(subscription: Stripe.Subscription): string | null {
    return subscription.metadata.organizationId
    ?? subscription.metadata.organization_id
    ?? null;
}

export function toDate(value: number | null): Date | null {
    return value ? new Date(value * 1000) : null;
}

export function getSubscriptionCurrentPeriodEnd(subscription: Stripe.Subscription): number | null {
    const itemEnds = subscription.items.data
        .map((item) => item.current_period_end)
        .filter((value): value is number => typeof value === 'number');

    if (itemEnds.length === 0) {
        return null;
    }

    return Math.max(...itemEnds);
}
