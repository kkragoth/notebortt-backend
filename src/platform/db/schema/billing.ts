import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from '@/platform/db/schema/users.js';

export const billingCustomerLinks = pgTable('billing_customer_links', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id'),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
    uniqueIndex('billing_customer_links_stripe_customer_idx').on(table.stripeCustomerId),
    uniqueIndex('billing_customer_links_user_idx').on(table.userId).where(sql`${table.userId} IS NOT NULL`),
    index('billing_customer_links_org_idx').on(table.organizationId),
]);

export const billingSubscriptions = pgTable('billing_subscriptions', {
    id: uuid('id').primaryKey().defaultRandom(),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    organizationId: text('organization_id'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull(),
    plan: text('plan').notNull(),
    priceId: text('price_id'),
    trialEnd: timestamp('trial_end', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    raw: jsonb('raw'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
    uniqueIndex('billing_subscriptions_stripe_subscription_idx').on(table.stripeSubscriptionId),
    index('billing_subscriptions_customer_idx').on(table.stripeCustomerId),
    index('billing_subscriptions_org_idx').on(table.organizationId),
    index('billing_subscriptions_user_idx').on(table.userId),
]);

export const billingWebhookEvents = pgTable('billing_webhook_events', {
    id: uuid('id').primaryKey().defaultRandom(),
    stripeEventId: text('stripe_event_id').notNull(),
    eventType: text('event_type').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow(),
    raw: jsonb('raw'),
}, (table) => [
    uniqueIndex('billing_webhook_events_stripe_event_idx').on(table.stripeEventId),
    index('billing_webhook_events_type_idx').on(table.eventType),
]);
