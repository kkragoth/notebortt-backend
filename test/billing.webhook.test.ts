import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { beginRollbackTx, closeFixtures } from './helpers/fixtures.js';
import type Stripe from 'stripe';
import type { RollbackTxHandle } from './helpers/fixtures.js';
import { createBillingWebhookDomain } from '@/modules/billing/billing/webhook-domain.js';
import { createBillingWebhookRouter } from '@/modules/billing/routes.js';

/**
 * Billing webhook signature + dispatch suite (P4.5 / item 77).
 */

const SECRET = 'whsec_test_secret';

function makeStripeStub(behavior: 'ok' | 'bad-signature' = 'ok'): Stripe {
    return {
        webhooks: {
            constructEvent: vi.fn((rawBody: Buffer, signature: string) => {
                if (behavior === 'bad-signature' || !signature.includes('t=')) {
                    // Mirrors stripe's StripeSignatureVerificationError shape.
                    throw new Error('No valid signature found in provided payload');
                }
                const payload = JSON.parse(rawBody.toString());
                return {
                    id: payload.id ?? `evt_${Date.now()}`,
                    type: payload.type,
                    data: { object: payload.data?.object ?? {} },
                } as unknown as Stripe.Event;
            }),
        },
    } as unknown as Stripe;
}

function makeDomain(db: RollbackTxHandle['db'], stripe: Stripe | null = makeStripeStub()) {
    const upsertCustomerLink = vi.fn().mockResolvedValue(undefined);
    const upsertSubscription = vi.fn().mockResolvedValue(undefined);
    const markSubscriptionCanceled = vi.fn().mockResolvedValue(undefined);
    const domain = createBillingWebhookDomain({
        db,
        stripe,
        stripeWebhookSecret: SECRET,
        upsertCustomerLink,
        upsertSubscription,
        markSubscriptionCanceled,
    });
    return { domain, upsertCustomerLink, upsertSubscription, markSubscriptionCanceled };
}

function signedBody(event: Record<string, unknown>): { body: string; signature: string } {
    const body = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, ...event });
    return { body, signature: `t=${Date.now()},v1=stub` };
}

describe('billing webhook domain', () => {
    let tx: RollbackTxHandle;

    beforeAll(async () => {
        tx = await beginRollbackTx();
    });

    afterAll(async () => {
        await tx.rollback();
        await closeFixtures();
    });

    it('refuses to run when stripe is not configured', async () => {
        const { domain } = makeDomain(tx.db, null);
        const { body, signature } = signedBody({ type: 'checkout.session.completed' });
        await expect(domain.handleWebhook(Buffer.from(body), signature)).rejects.toThrow(/not configured/i);
    });

    it('requires a signature header', async () => {
        const { domain } = makeDomain(tx.db);
        const { body } = signedBody({ type: 'checkout.session.completed' });
        await expect(domain.handleWebhook(Buffer.from(body), undefined)).rejects.toThrow(/missing stripe signature/i);
    });

    it('rejects payloads whose signature does not verify', async () => {
        const stripe = makeStripeStub('bad-signature');
        const { domain } = makeDomain(tx.db, stripe);
        const { body, signature } = signedBody({ type: 'checkout.session.completed' });
        await expect(domain.handleWebhook(Buffer.from(body), signature)).rejects.toThrow(/signature/i);
        expect(stripe.webhooks.constructEvent).toHaveBeenCalledOnce();
    });

    it('dispatches checkout.session.completed exactly once and dedupes replays', async () => {
        const { domain, upsertCustomerLink } = makeDomain(tx.db);
        const eventId = `evt_dedupe_${Date.now()}`;
        const event = {
            id: eventId,
            type: 'checkout.session.completed',
            data: {
                object: {
                    customer: 'cus_123',
                    customer_details: { email: 'buyer@example.com' },
                    metadata: { userId: '11111111-1111-4111-8111-111111111111' },
                },
            },
        };
        const first = signedBody(event);

        await expect(domain.handleWebhook(Buffer.from(first.body), first.signature)).resolves.toEqual({ duplicate: false });
        expect(upsertCustomerLink).toHaveBeenCalledTimes(1);
        expect(upsertCustomerLink).toHaveBeenCalledWith(
            'cus_123',
            '11111111-1111-4111-8111-111111111111',
            null,
            'buyer@example.com',
        );

        // Replay of the same Stripe event id is a no-op (signedBody keeps
        // event.id, so both deliveries share the same dedupe key).
        const replay = signedBody(event);
        await expect(domain.handleWebhook(Buffer.from(replay.body), replay.signature))
            .resolves.toEqual({ duplicate: true });
        expect(upsertCustomerLink).toHaveBeenCalledTimes(1);
    });

    it('routes subscription lifecycle events to the right handlers', async () => {
        const { domain, upsertSubscription, markSubscriptionCanceled } = makeDomain(tx.db);

        const subEvent = signedBody({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } });
        await expect(domain.handleWebhook(Buffer.from(subEvent.body), subEvent.signature)).resolves.toEqual({ duplicate: false });

        const cancelEvent = signedBody({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_2' } } });
        await expect(domain.handleWebhook(Buffer.from(cancelEvent.body), cancelEvent.signature)).resolves.toEqual({ duplicate: false });

        expect(upsertSubscription).toHaveBeenCalledTimes(1);
        expect(markSubscriptionCanceled).toHaveBeenCalledTimes(1);
    });
});

describe('billing webhook route', () => {
    function buildApp(service: { handleWebhook: (...args: unknown[]) => Promise<unknown> }) {
        const app = express();
        app.use('/', createBillingWebhookRouter(service as never));
        return app;
    }

    it('maps signature failures to 400 without leaking internals', async () => {
        const service = {
            handleWebhook: vi.fn(async () => {
                throw new Error('Stripe webhook signature verification failed');
            }),
        };
        const res = await request(buildApp(service))
            .post('/billing/webhook')
            .set('content-type', 'application/json')
            .set('stripe-signature', 'garbage')
            .send({ type: 'checkout.session.completed' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/signature/i);
    });

    it('acks processed webhooks with received:true', async () => {
        const service = { handleWebhook: vi.fn(async () => ({ duplicate: false })) };
        const res = await request(buildApp(service))
            .post('/billing/webhook')
            .set('content-type', 'application/json')
            .set('stripe-signature', 't=1,v1=x')
            .send({ type: 'checkout.session.completed' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true });
    });
});
