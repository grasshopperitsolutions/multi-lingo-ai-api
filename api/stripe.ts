import Stripe from 'stripe';
import { buffer } from 'micro';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { db, FieldValue } from '../lib/firebase-admin';
import { logInfo, logWarn, logError, startTimer } from '../lib/logger';
import type { VercelRequest, VercelResponse, SubscriptionTier, StripeCheckoutRequest } from '../lib/types';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
});

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const FRONTEND_URL = process.env.FRONTEND_URL!;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Maps a Stripe Price ID to an internal subscription tier. */
function tierFromPriceId(priceId: string): SubscriptionTier {
  const voyagerPrices = [
    process.env.STRIPE_PRICE_VOYAGER_MONTHLY,
    process.env.STRIPE_PRICE_VOYAGER_YEARLY,
  ];
  const maestroPrices = [
    process.env.STRIPE_PRICE_MAESTRO_MONTHLY,
    process.env.STRIPE_PRICE_MAESTRO_YEARLY,
  ];
  if (voyagerPrices.includes(priceId)) return 'voyager';
  if (maestroPrices.includes(priceId)) return 'maestro';
  return 'explorer';
}

/** Looks up the Firebase UID for a given Stripe Customer ID. */
async function uidFromCustomerId(customerId: string): Promise<string | null> {
  const snapshot = await db
    .collection('users')
    .where('stripeCustomerId', '==', customerId)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return snapshot.docs[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleCheckout(
  req: VercelRequest,
  res: VercelResponse,
  uid: string,
  elapsed: () => number
) {
  const { priceId } = req.body as StripeCheckoutRequest;

  if (!priceId) {
    return errorResponse(res, 'Missing required field: priceId', 400);
  }

  const userDoc = await db.collection('users').doc(uid).get();
  const userData = userDoc.data() ?? {};
  let stripeCustomerId: string = userData.stripeCustomerId ?? '';

  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      metadata: { firebaseUid: uid },
      ...(userData.email ? { email: userData.email } : {}),
    });
    stripeCustomerId = customer.id;
    await db.collection('users').doc(uid).set(
      { stripeCustomerId, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: 7,
      metadata: { firebaseUid: uid },
    },
    success_url: `${FRONTEND_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${FRONTEND_URL}/subscription/cancel`,
  });

  logInfo('stripe_checkout_created', 'stripe', {
    uid, priceId, sessionId: session.id, statusCode: 200, durationMs: elapsed(),
  });

  return successResponse(res, { url: session.url });
}

async function handlePortal(
  req: VercelRequest,
  res: VercelResponse,
  uid: string,
  elapsed: () => number
) {
  const userDoc = await db.collection('users').doc(uid).get();
  const stripeCustomerId = userDoc.data()?.stripeCustomerId;

  if (!stripeCustomerId) {
    return errorResponse(res, 'No active subscription found', 404);
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${FRONTEND_URL}/settings`,
  });

  logInfo('stripe_portal_created', 'stripe', {
    uid, statusCode: 200, durationMs: elapsed(),
  });

  return successResponse(res, { url: portalSession.url });
}

async function handleWebhook(
  req: VercelRequest,
  res: VercelResponse,
  elapsed: () => number
) {
  let rawBody: Buffer;
  try {
    rawBody = await buffer(req as any);
  } catch {
    return errorResponse(res, 'Failed to read request body', 400);
  }

  const sig = (req as any).headers['stripe-signature'];

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (err: any) {
    logWarn('stripe_webhook_invalid_sig', 'stripe', {
      errorMessage: err?.message, statusCode: 400, durationMs: elapsed(),
    });
    return errorResponse(res, `Webhook signature verification failed: ${err?.message}`, 400);
  }

  logInfo('stripe_webhook_received', 'stripe', {
    eventType: event.type, eventId: event.id, durationMs: elapsed(),
  });

  switch (event.type) {

    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== 'subscription') break;

      const customerId = session.customer as string;
      const subscriptionId = session.subscription as string;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const tier = tierFromPriceId(subscription.items.data[0]?.price.id);
      const uid = session.metadata?.firebaseUid ?? await uidFromCustomerId(customerId);

      if (!uid) {
        logWarn('stripe_webhook_uid_not_found', 'stripe', { customerId, eventType: event.type });
        break;
      }

      await db.collection('users').doc(uid).set({
        subscriptionTier: tier,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: subscription.status,
        currentPeriodEnd: subscription.current_period_end,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      logInfo('stripe_webhook_activated', 'stripe', { uid, tier, subscriptionId, durationMs: elapsed() });
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;
      const tier = tierFromPriceId(subscription.items.data[0]?.price.id);
      const uid = await uidFromCustomerId(customerId);

      if (!uid) {
        logWarn('stripe_webhook_uid_not_found', 'stripe', { customerId, eventType: event.type });
        break;
      }

      await db.collection('users').doc(uid).set({
        subscriptionTier: tier,
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        currentPeriodEnd: subscription.current_period_end,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      logInfo('stripe_webhook_updated', 'stripe', { uid, tier, status: subscription.status, durationMs: elapsed() });
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const uid = await uidFromCustomerId(subscription.customer as string);
      if (!uid) break;

      await db.collection('users').doc(uid).set({
        subscriptionTier: 'explorer',
        stripeSubscriptionId: null,
        subscriptionStatus: 'canceled',
        currentPeriodEnd: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      logInfo('stripe_webhook_canceled', 'stripe', { uid, durationMs: elapsed() });
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const uid = await uidFromCustomerId(invoice.customer as string);
      if (!uid) break;

      await db.collection('users').doc(uid).set({
        subscriptionStatus: 'past_due',
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      logWarn('stripe_webhook_payment_failed', 'stripe', { uid, durationMs: elapsed() });
      break;
    }

    default:
      logInfo('stripe_webhook_ignored', 'stripe', { eventType: event.type, durationMs: elapsed() });
  }

  return successResponse(res, { received: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Handler
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleCors(req, res)) return;

  const elapsed = startTimer();

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  // Detect Stripe webhook by its signature header — no user auth needed, signature is the proof
  const isWebhook = !!((req as any).headers['stripe-signature']);

  if (isWebhook) {
    try {
      return await handleWebhook(req, res, elapsed);
    } catch (err: any) {
      logError('stripe_webhook_error', 'stripe', { errorMessage: err?.message, durationMs: elapsed() });
      return errorResponse(res, err?.message ?? 'Webhook handler failed', 500);
    }
  }

  // All other actions require Firebase Auth
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const { action } = req.body ?? {};

  try {
    switch (action) {
      case 'checkout':
        return await handleCheckout(req, res, uid, elapsed);
      case 'portal':
        return await handlePortal(req, res, uid, elapsed);
      default:
        return errorResponse(res, `Unknown action: "${action}". Valid actions: checkout, portal`, 400);
    }
  } catch (err: any) {
    logError('stripe_action_error', 'stripe', {
      uid, action, errorMessage: err?.message, statusCode: 500, durationMs: elapsed(),
    });
    return errorResponse(res, err?.message ?? 'Stripe action failed', 500);
  }
}
