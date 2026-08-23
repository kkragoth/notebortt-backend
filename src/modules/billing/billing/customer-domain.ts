import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import type { Database } from '@/platform/db/client.js';
import { billingCustomerLinks } from '@/platform/db/schema.js';

interface CustomerDomainDeps {
  db: Database
  stripe: Stripe | null
}

export function createBillingCustomerDomain(deps: CustomerDomainDeps) {
    const { db, stripe } = deps;

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
            });
    }

    async function findStripeCustomerByUser(userId: string, email: string): Promise<Stripe.Customer | null> {
        if (!stripe) {
            return null;
        }

        const existingLink = await db
            .select({ stripeCustomerId: billingCustomerLinks.stripeCustomerId })
            .from(billingCustomerLinks)
            .where(eq(billingCustomerLinks.userId, userId))
            .limit(1);

        if (existingLink[0]) {
            const customer = await stripe.customers.retrieve(existingLink[0].stripeCustomerId);
            if (!('deleted' in customer)) {
                return customer;
            }
        }

        const customerList = await stripe.customers.list({ email, limit: 20 });
        const customer = customerList.data.find((item) => item.metadata?.userId === userId) ?? customerList.data[0];
        if (customer) {
            await upsertCustomerLink(customer.id, userId, null, customer.email ?? null);
        }

        return customer ?? null;
    }

    async function getOrCreateStripeCustomer(userId: string, email: string, name: string): Promise<Stripe.Customer> {
        if (!stripe) {
            throw new Error('Stripe billing is not configured');
        }

        const existing = await findStripeCustomerByUser(userId, email);
        if (existing) {
            return existing;
        }

        const customer = await stripe.customers.create({
            email,
            name,
            metadata: { userId },
        });
        await upsertCustomerLink(customer.id, userId, null, customer.email ?? email);
        return customer;
    }

    return {
        upsertCustomerLink,
        findStripeCustomerByUser,
        getOrCreateStripeCustomer,
    };
}
