import { desc, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import {
    PLAN_LIMITS,
    getPlanFromPriceId,
    getPlanFromSubscriptionRecord,
    pickActiveSubscription
  
  
} from '../billing/shared.js';
import type { Database } from '@/platform/db/client.js';
import type { BoardService } from '@/modules/boards/index.js';
import type { UserService } from '@/modules/users/index.js';
import type { WorkspaceService } from '@/modules/workspaces/index.js';
import type {BillingProfile, BillingServiceConfig} from '../billing/shared.js';
import { billingSubscriptions } from '@/platform/db/schema.js';

interface ProfileDomainDeps {
  config: Pick<BillingServiceConfig, 'nodeEnv' | 'stripePriceStartup' | 'stripePriceBusiness'>
  db: Database
  stripe: Stripe | null
  userService: UserService
  workspaceService: WorkspaceService
  boardService: BoardService
  findStripeCustomerByUser: (userId: string, email: string) => Promise<Stripe.Customer | null>
  upsertSubscription: (subscription: Stripe.Subscription) => Promise<void>
}

export function createBillingProfileDomain(deps: ProfileDomainDeps) {
    const {
        config,
        db,
        stripe,
        userService,
        workspaceService,
        boardService,
        findStripeCustomerByUser,
        upsertSubscription,
    } = deps;

    async function getUsageCounters(userId: string): Promise<BillingProfile['usageCounters']> {
        const [workspaces, boards] = await Promise.all([
            workspaceService.getWorkspacesForUser(userId),
            boardService.listAccessibleBoards(userId),
        ]);

        const boardsByWorkspace = new Map<string, number>();
        for (const board of boards) {
            boardsByWorkspace.set(board.workspaceId, (boardsByWorkspace.get(board.workspaceId) ?? 0) + 1);
        }

        return {
            workspacesUsed: workspaces.length,
            boardsInCurrentWorkspace: Math.max(0, ...boardsByWorkspace.values()),
            largestBoardElements: 0,
            realtimeUsersCurrentBoard: 1,
        };
    }

    async function fetchCurrentBillingProfile(userId: string): Promise<BillingProfile> {
        const user = await userService.getUserById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        const usageCounters = await getUsageCounters(userId);

        if (!stripe) {
            const isDevOverride = config.nodeEnv !== 'production';
            const currentPlan = isDevOverride ? 'dev' : 'free';

            return {
                currentPlan,
                trialExpirationTimestamp: null,
                usageCounters,
                limits: PLAN_LIMITS[currentPlan],
                flags: {
                    isDevOverride,
                    isTrialActive: false,
                },
            };
        }

        const subscriptionRows = await db
            .select()
            .from(billingSubscriptions)
            .where(eq(billingSubscriptions.userId, userId))
            .orderBy(desc(billingSubscriptions.updatedAt))
            .limit(1);

        const storedSubscription = subscriptionRows[0];
        if (storedSubscription && ['trialing', 'active', 'past_due', 'unpaid'].includes(storedSubscription.status)) {
            const plan = getPlanFromSubscriptionRecord(storedSubscription);
            const trialExpirationTimestamp = storedSubscription.trialEnd ? new Date(storedSubscription.trialEnd).getTime() : null;

            return {
                currentPlan: plan,
                trialExpirationTimestamp,
                usageCounters,
                limits: PLAN_LIMITS[plan],
                flags: {
                    isDevOverride: false,
                    isTrialActive: plan === 'trial' && Boolean(trialExpirationTimestamp && trialExpirationTimestamp > Date.now()),
                },
            };
        }

        const customer = await findStripeCustomerByUser(user.id, user.email);
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
            };
        }

        const subscriptions = await stripe.subscriptions.list({
            customer: customer.id,
            status: 'all',
            limit: 20,
            expand: ['data.items.data.price'],
        });
        const activeSubscription = pickActiveSubscription(subscriptions.data);

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
            };
        }

        await upsertSubscription(activeSubscription);
        const plan = activeSubscription.status === 'trialing'
            ? 'trial'
            : getPlanFromPriceId(activeSubscription.items.data[0]?.price.id, config);
        const trialExpirationTimestamp = activeSubscription.trial_end ? activeSubscription.trial_end * 1000 : null;

        return {
            currentPlan: plan,
            trialExpirationTimestamp,
            usageCounters,
            limits: PLAN_LIMITS[plan],
            flags: {
                isDevOverride: false,
                isTrialActive: plan === 'trial' && Boolean(trialExpirationTimestamp && trialExpirationTimestamp > Date.now()),
            },
        };
    }

    return {
        fetchCurrentBillingProfile,
    };
}
