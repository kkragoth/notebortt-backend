import express, { Router } from 'express';
import { z } from 'zod';
import type { RequestHandler } from 'express';
import type { BillingService } from '@/services/billing.service.js';
import { sendBadRequest } from '@/lib/http.js';
import { parseWithSchema } from '@/lib/validation.js';

const checkoutSchema = z.object({
    plan: z.enum(['startup', 'business']),
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
});

const portalSchema = z.object({
    returnUrl: z.string().url().optional(),
});

function mapBillingErrorToStatus(error: unknown): number {
    const message = error instanceof Error ? error.message : 'Billing request failed';

    if (message.includes('not configured')) {
        return 503;
    }
    if (message.includes('only available')) {
        return 400;
    }
    if (message.includes('signature') || message.includes('configured') || message.includes('webhook')) {
        return 400;
    }
    if (message.includes('User not found')) {
        return 404;
    }

    return 500;
}

export function createBillingRouter(
    billingService: BillingService,
    authMiddleware: RequestHandler,
) {
    const router = Router();

    router.get('/billing/profile', authMiddleware, async (req, res) => {
        try {
            const profile = await billingService.fetchCurrentBillingProfile(req.userId as string);
            res.json(profile);
        } catch (error) {
            const status = mapBillingErrorToStatus(error);
            res.status(status).json({ error: error instanceof Error ? error.message : 'Failed to fetch billing profile' });
        }
    });

    router.post('/billing/checkout', authMiddleware, async (req, res) => {
        const parsed = parseWithSchema(checkoutSchema, req.body);
        if (!parsed.success) {
            sendBadRequest(res, parsed.error.error);
            return;
        }

        try {
            const response = await billingService.startCheckout(req.userId as string, parsed.data);
            res.json(response);
        } catch (error) {
            const status = mapBillingErrorToStatus(error);
            res.status(status).json({ error: error instanceof Error ? error.message : 'Failed to start checkout' });
        }
    });

    router.post('/billing/portal', authMiddleware, async (req, res) => {
        const parsed = parseWithSchema(portalSchema, req.body);
        if (!parsed.success) {
            sendBadRequest(res, parsed.error.error);
            return;
        }

        try {
            const response = await billingService.openBillingPortal(req.userId as string, parsed.data.returnUrl);
            res.json(response);
        } catch (error) {
            const status = mapBillingErrorToStatus(error);
            res.status(status).json({ error: error instanceof Error ? error.message : 'Failed to open billing portal' });
        }
    });

    return router;
}

export function createBillingWebhookRouter(billingService: BillingService) {
    const router = Router();

    router.post(
        '/billing/webhook',
        express.raw({ type: 'application/json' }),
        async (req, res) => {
            const signatureHeader = req.headers['stripe-signature'];
            const signature = typeof signatureHeader === 'string' ? signatureHeader : signatureHeader?.[0];
            const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);

            try {
                await billingService.handleWebhook(rawBody, signature);
                res.json({ received: true });
            } catch (error) {
                const status = mapBillingErrorToStatus(error);
                res.status(status).json({ error: error instanceof Error ? error.message : 'Failed to process webhook' });
            }
        },
    );

    return router;
}
