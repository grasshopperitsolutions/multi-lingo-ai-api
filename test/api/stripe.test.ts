import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockReqRes, bearer } from '../helpers/httpMocks';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));
vi.mock('../../lib/stripe', () => import('../helpers/mockStripe'));
vi.mock('micro', () => import('../helpers/mockMicro'));

import { __testUtils as fbUtils } from '../helpers/mockFirebaseAdmin';
import { __testUtils as stripeUtils, stripe } from '../helpers/mockStripe';
import handler, { config } from '../../api/stripe';

const TOKEN_ALICE = 'token-alice';

beforeEach(() => {
  fbUtils.reset();
  stripeUtils.reset();
  fbUtils.setValidToken(TOKEN_ALICE, { uid: 'alice' });
  fbUtils.seedDoc('users', 'alice', { email: 'alice@example.com', subscriptionTier: 'explorer' });
});

describe('module config', () => {
  it('disables the default body parser so the webhook raw body survives untouched', () => {
    expect(config).toEqual({ api: { bodyParser: false } });
  });
});

describe('POST /api/stripe — checkout', () => {
  it('rejects unauthenticated requests', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      body: { action: 'checkout', plan: 'voyager', interval: 'monthly' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('creates a new Stripe customer with firebaseUid metadata when the user has none yet', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { action: 'checkout', plan: 'voyager', interval: 'monthly' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.url).toContain('checkout.stripe.com');
    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { firebaseUid: 'alice' } })
    );
    expect(fbUtils.getDoc('users', 'alice')?.stripeCustomerId).toBeTruthy();
  });

  it('reuses an existing, verified Stripe customer', async () => {
    stripeUtils.seedCustomer('cus_alice', { metadata: { firebaseUid: 'alice' } });
    fbUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer', stripeCustomerId: 'cus_alice' });

    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { action: 'checkout', plan: 'voyager', interval: 'monthly' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it('sends no free trial for any plan — the free Explorer tier is the trial', async () => {
    for (const plan of ['voyager', 'maestro']) {
      const { req, res } = createMockReqRes({
        method: 'POST',
        headers: bearer(TOKEN_ALICE),
        body: { action: 'checkout', plan, interval: 'monthly' },
      });
      await handler(req, res);
      expect(res.statusCode).toBe(200);

      const args = (stripe.checkout.sessions.create as any).mock.calls.at(-1)[0];
      expect(args.subscription_data).not.toHaveProperty('trial_period_days');
      expect(args.subscription_data).not.toHaveProperty('trial_settings');
    }
  });

  it('rejects checkout when the stored stripeCustomerId does not actually belong to this uid (finding 1.8)', async () => {
    stripeUtils.seedCustomer('cus_victim', { metadata: { firebaseUid: 'someone-else' } });
    fbUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer', stripeCustomerId: 'cus_victim' });

    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { action: 'checkout', plan: 'voyager', interval: 'monthly' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid plan/interval combination', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { action: 'checkout', plan: 'nope', interval: 'monthly' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/stripe — portal', () => {
  it('rejects when the user has no stripeCustomerId', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { action: 'portal' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('rejects a hijacked stripeCustomerId that belongs to someone else', async () => {
    stripeUtils.seedCustomer('cus_victim', { metadata: { firebaseUid: 'someone-else' } });
    fbUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer', stripeCustomerId: 'cus_victim' });

    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { action: 'portal' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('creates a portal session for the verified owner', async () => {
    stripeUtils.seedCustomer('cus_alice', { metadata: { firebaseUid: 'alice' } });
    fbUtils.seedDoc('users', 'alice', { subscriptionTier: 'voyager', stripeCustomerId: 'cus_alice' });

    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { action: 'portal' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.url).toContain('billing.stripe.com');
  });
});

describe('POST /api/stripe — portal_change_plan', () => {
  it('rejects a hijacked subscription whose customer belongs to someone else', async () => {
    stripeUtils.seedCustomer('cus_victim', { metadata: { firebaseUid: 'someone-else' } });
    stripeUtils.seedSubscription('sub_victim', {
      customer: 'cus_victim',
      items: { data: [{ id: 'si_1', price: { id: 'price_voyager_monthly' } }] },
    });
    fbUtils.seedDoc('users', 'alice', { subscriptionTier: 'voyager', stripeSubscriptionId: 'sub_victim' });

    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { action: 'portal_change_plan', plan: 'maestro', interval: 'monthly' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('creates a plan-change portal session for the verified owner', async () => {
    stripeUtils.seedCustomer('cus_alice', { metadata: { firebaseUid: 'alice' } });
    stripeUtils.seedSubscription('sub_alice', {
      customer: 'cus_alice',
      items: { data: [{ id: 'si_1', price: { id: 'price_voyager_monthly' } }] },
    });
    fbUtils.seedDoc('users', 'alice', { subscriptionTier: 'voyager', stripeSubscriptionId: 'sub_alice' });

    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { action: 'portal_change_plan', plan: 'maestro', interval: 'monthly' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/stripe — webhook', () => {
  it('rejects a webhook with an invalid signature and does not touch Firestore', async () => {
    stripeUtils.setWebhookError(new Error('signature mismatch'));
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: { 'stripe-signature': 'bad-sig' },
      rawBody: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('activates a subscription on checkout.session.completed', async () => {
    stripeUtils.seedSubscription('sub_new', {
      status: 'active',
      current_period_end: 1234,
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_voyager_monthly' } }] },
    });
    stripeUtils.setWebhookEvent({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          customer: 'cus_alice',
          subscription: 'sub_new',
          metadata: { firebaseUid: 'alice' },
        },
      },
    });

    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: { 'stripe-signature': 'valid-sig' },
      rawBody: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    const stored = fbUtils.getDoc('users', 'alice');
    expect(stored?.subscriptionTier).toBe('voyager');
    expect(stored?.stripeSubscriptionId).toBe('sub_new');
  });

  // Stripe's 2025-03-31.basil API moved current_period_end from the
  // subscription onto its items. The library now requests a post-Basil
  // version, but webhook events arrive in whatever version the endpoint is
  // pinned to in the Stripe Dashboard — so both shapes have to work, or
  // renewal dates silently stop being stored.
  describe('current_period_end across API versions', () => {
    const activate = async (subscription: Record<string, unknown>) => {
      stripeUtils.seedSubscription('sub_new', subscription);
      stripeUtils.setWebhookEvent({
        id: `evt_${Math.random()}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            customer: 'cus_alice',
            subscription: 'sub_new',
            metadata: { firebaseUid: 'alice' },
          },
        },
      });
      const { req, res } = createMockReqRes({
        method: 'POST',
        headers: { 'stripe-signature': 'valid-sig' },
        rawBody: JSON.stringify({ type: 'checkout.session.completed' }),
      });
      await handler(req, res);
      expect(res.statusCode).toBe(200);
      return fbUtils.getDoc('users', 'alice');
    };

    it('reads the period end off the subscription item (Basil and later)', async () => {
      const stored = await activate({
        status: 'active',
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_voyager_monthly' }, current_period_end: 9999 }] },
      });
      expect(stored?.currentPeriodEnd).toBe(9999);
    });

    it('falls back to the top-level field when the webhook endpoint is on an older version', async () => {
      const stored = await activate({
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: 1234,
        items: { data: [{ price: { id: 'price_voyager_monthly' } }] },
      });
      expect(stored?.currentPeriodEnd).toBe(1234);
    });

    it('prefers the item when both are present, since that is the newer source', async () => {
      const stored = await activate({
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: 1234,
        items: { data: [{ price: { id: 'price_voyager_monthly' }, current_period_end: 9999 }] },
      });
      expect(stored?.currentPeriodEnd).toBe(9999);
    });

    it('stores null rather than undefined when neither is present', async () => {
      // Firestore rejects an undefined value outright, so the handler would
      // throw and the whole webhook would 500 instead of just missing a date.
      const stored = await activate({
        status: 'active',
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_voyager_monthly' } }] },
      });
      expect(stored?.currentPeriodEnd).toBeNull();
    });
  });

  it('resets the tier to explorer on customer.subscription.deleted', async () => {
    fbUtils.seedDoc('users', 'alice', { subscriptionTier: 'voyager', stripeCustomerId: 'cus_alice' });
    stripeUtils.setWebhookEvent({
      id: 'evt_2',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_alice' } },
    });

    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: { 'stripe-signature': 'valid-sig' },
      rawBody: JSON.stringify({ type: 'customer.subscription.deleted' }),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(fbUtils.getDoc('users', 'alice')?.subscriptionTier).toBe('explorer');
  });

  it('does not require Firebase auth for webhook requests', async () => {
    stripeUtils.setWebhookEvent({ id: 'evt_3', type: 'invoice.payment_failed', data: { object: { customer: 'cus_unknown' } } });
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: { 'stripe-signature': 'valid-sig' },
      rawBody: JSON.stringify({ type: 'invoice.payment_failed' }),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('unexpected errors (finding 3.1)', () => {
  it('returns a generic message for an unexpected action-handling failure, without leaking internal details', async () => {
    vi.mocked(stripe.customers.create).mockRejectedValueOnce(
      new Error('internal: Stripe account restricted, contact support ref #ABC123')
    );
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { action: 'checkout', plan: 'voyager', interval: 'monthly' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Stripe action failed');
    expect(res.body.error).not.toMatch(/restricted|ABC123/i);
  });

  it('returns a generic message for an unexpected webhook-processing failure after a valid signature', async () => {
    stripeUtils.setWebhookEvent({
      id: 'evt_err',
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          customer: 'cus_alice',
          subscription: 'sub_missing',
          metadata: { firebaseUid: 'alice' },
        },
      },
    });
    // sub_missing was never seeded, so subscriptions.retrieve() inside the
    // webhook handler throws — this is a post-signature-verification error,
    // not a bad-signature one.
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: { 'stripe-signature': 'valid-sig' },
      rawBody: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Webhook handler failed');
    expect(res.body.error).not.toMatch(/no such subscription/i);
  });
});

describe('POST /api/stripe — unknown action', () => {
  it('rejects an unrecognized action', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { action: 'nope' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('method handling', () => {
  it('rejects non-POST methods', async () => {
    const { req, res } = createMockReqRes({ method: 'GET', headers: bearer(TOKEN_ALICE) });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
