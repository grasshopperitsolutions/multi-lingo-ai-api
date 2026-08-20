import type Stripe from 'stripe';
import { buffer } from 'micro';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { db, FieldValue } from '../lib/firebase-admin';
import { stripe } from '../lib/stripe';
import { logInfo, logWarn, logError, startTimer } from '../lib/logger';
import type { VercelRequest, VercelResponse, SubscriptionTier, StripeCheckoutRequest } from '../lib/types';

// Vercel would otherwise auto-parse the JSON body before this handler runs,
// consuming the raw request stream and breaking the webhook signature check
// below (constructEvent needs the exact bytes Stripe signed). Only the
// webhook path needs the raw body — handleCheckout/handlePortal/etc. still
// read `req.body` normally, since (per Vercel's fallback behavior with
// bodyParser disabled) nothing else on this route depends on auto-parsing.
export const config = {
  api: {
    bodyParser: false,
  },
};

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const FRONTEND_URL = process.env.FRONTEND_URL!;

// ─────────────────────────────────────────────────────────────────────────────
// Price ID map — resolved server-side from plan + interval
// ─────────────────────────────────────────────────────────────────────────────

const PRICE_ID_MAP: Record<string, Record<string, string | undefined>> = {
  voyager: {
    monthly: process.env.STRIPE_PRICE_VOYAGER_MONTHLY,
    yearly:  process.env.STRIPE_PRICE_VOYAGER_YEARLY,
  },
  maestro: {
    monthly: process.env.STRIPE_PRICE_MAESTRO_MONTHLY,
    yearly:  process.env.STRIPE_PRICE_MAESTRO_YEARLY,
  },
};

/**
 * Free trial length per plan, in days. Omitted entirely (no trial) for plans
 * not listed here — which is currently every plan: the free Explorer tier is
 * the trial. Add a row back here to re-enable one; the checkout session below
 * already handles both cases.
 *
 * NOTE: this only controls trials for *new* checkouts. A trial configured on
 * the Stripe Price itself would still apply, and subscriptions already in a
 * trial keep running until their existing trial_end.
 */
const TRIAL_DAYS_BY_PLAN: Record<string, number> = {};

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

/**
 * Confirms a Stripe customer actually belongs to `uid`, via the
 * metadata.firebaseUid stamped on it when handleCheckout first creates it.
 * Defense-in-depth: stripeCustomerId/stripeSubscriptionId on a user's
 * Firestore doc are already un-writable by any client request (see
 * ALWAYS_PROTECTED_USER_FIELDS in lib/firestore-helpers.ts), but this
 * closes the same gap at the Stripe layer too, in case that Firestore doc
 * is ever populated some other way.
 */
async function verifyCustomerOwnership(stripeCustomerId: string, uid: string): Promise<boolean> {
  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if ((customer as Stripe.DeletedCustomer).deleted) return false;
    return (customer as Stripe.Customer).metadata?.firebaseUid === uid;
  } catch {
    return false;
  }
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
  const { plan, interval } = req.body as StripeCheckoutRequest;

  if (!plan || !interval) {
    return errorResponse(res, 'Missing required fields: plan and interval', 400);
  }

  const priceId = PRICE_ID_MAP[plan]?.[interval];

  if (!priceId) {
    return errorResponse(
      res,
      `Invalid plan/interval combination: ${plan}/${interval}. Valid plans: voyager, maestro. Valid intervals: monthly, yearly.`,
      400
    );
  }

  const userDoc = await db.collection('users').doc(uid).get();
  const userData = userDoc.data() ?? {};
  let stripeCustomerId: string = userData.stripeCustomerId ?? '';

  if (stripeCustomerId && !(await verifyCustomerOwnership(stripeCustomerId, uid))) {
    logWarn('stripe_customer_ownership_mismatch', 'stripe', { uid, stripeCustomerId });
    return errorResponse(res, 'Stripe customer record is inconsistent with this account. Please contact support.', 409);
  }

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

  const trialDays = TRIAL_DAYS_BY_PLAN[plan];

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    // Only collect a card if something is actually due today. Combined with
    // trial_settings below, a trial (or a 100%-off promo code) can be
    // completed with no payment method on file at all.
    payment_method_collection: 'if_required',
    subscription_data: {
      ...(trialDays
        ? {
            trial_period_days: trialDays,
            // No card on file when the trial ends -> cancel cleanly rather
            // than attempt a charge. The Stripe webhook already resets the
            // user's tier back to 'explorer' on customer.subscription.deleted.
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          }
        : {}),
      metadata: { firebaseUid: uid },
    },
    // One shared result page for every outcome — see handlePortal()'s comment
    // for why (the Portal can only ever have one return_url, so the result
    // page already has to read Firestore state to know what happened; reusing
    // it here too means success and cancel don't need separate pages).
    success_url: `${FRONTEND_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${FRONTEND_URL}/subscription/success`,
  });

  logInfo('stripe_checkout_created', 'stripe', {
    uid, plan, interval, priceId, sessionId: session.id, statusCode: 200, durationMs: elapsed(),
  });

  return successResponse(res, { url: session.url });
}

async function handlePortalPlanChange(
  req: VercelRequest,
  res: VercelResponse,
  uid: string,
  elapsed: () => number
) {
  const { plan, interval } = req.body as StripeCheckoutRequest;

  if (!plan || !interval) {
    return errorResponse(res, 'Missing required fields: plan and interval', 400);
  }

  const priceId = PRICE_ID_MAP[plan]?.[interval];

  if (!priceId) {
    return errorResponse(
      res,
      `Invalid plan/interval combination: ${plan}/${interval}. Valid plans: voyager, maestro. Valid intervals: monthly, yearly.`,
      400
    );
  }

  const userDoc = await db.collection('users').doc(uid).get();
  const userData = userDoc.data() ?? {};
  const subscriptionId: string | undefined = userData.stripeSubscriptionId;

  if (!subscriptionId) {
    return errorResponse(res, 'No active subscription to change — subscribe first via checkout.', 400);
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  if (!(await verifyCustomerOwnership(subscription.customer as string, uid))) {
    logWarn('stripe_customer_ownership_mismatch', 'stripe', { uid, subscriptionId });
    return errorResponse(res, 'Stripe customer record is inconsistent with this account. Please contact support.', 409);
  }

  const currentItem = subscription.items.data[0];

  if (!currentItem) {
    return errorResponse(res, 'Subscription has no billable item', 400);
  }

  if (currentItem.price.id === priceId) {
    return errorResponse(res, `Already subscribed to ${plan}/${interval}.`, 400);
  }

  // Deep-links straight into the Portal's plan-change confirmation screen
  // for this specific price — skips Stripe's own plan picker since the
  // customer already chose on our Pricing page. Requires "Update subscription"
  // enabled in the Stripe Dashboard's Customer Portal settings.
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: subscription.customer as string,
    return_url: `${FRONTEND_URL}/subscription/success`,
    flow_data: {
      type: 'subscription_update_confirm',
      subscription_update_confirm: {
        subscription: subscriptionId,
        items: [{ id: currentItem.id, price: priceId, quantity: 1 }],
      },
    },
  });

  logInfo('stripe_portal_plan_change_created', 'stripe', {
    uid, plan, interval, priceId, subscriptionId, statusCode: 200, durationMs: elapsed(),
  });

  return successResponse(res, { url: portalSession.url });
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

  if (!(await verifyCustomerOwnership(stripeCustomerId, uid))) {
    logWarn('stripe_customer_ownership_mismatch', 'stripe', { uid, stripeCustomerId });
    return errorResponse(res, 'Stripe customer record is inconsistent with this account. Please contact support.', 409);
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    // The Portal supports exactly one return_url for every possible action
    // taken inside it (cancel, update card, view invoices, or nothing) — it
    // can't branch by outcome. The shared result page reads Firestore state
    // itself to decide what to show, so one URL is genuinely all we need.
    return_url: `${FRONTEND_URL}/subscription/success`,
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
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
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
        // Portal cancellations are deferred to period end by default — the
        // subscription stays "active" (full access) the whole time, so this
        // is the only signal the frontend has that a cancellation was scheduled.
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      logInfo('stripe_webhook_updated', 'stripe', { uid, tier, status: subscription.status, cancelAtPeriodEnd: subscription.cancel_at_period_end, durationMs: elapsed() });
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
        cancelAtPeriodEnd: false,
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
      return errorResponse(res, 'Webhook handler failed', 500);
    }
  }

  // All other actions require Firebase Auth
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  // bodyParser is disabled for this whole route (see `config` above, needed
  // for the webhook signature check) so req.body was never auto-populated
  // here — read and parse it ourselves before anything below touches it.
  let rawBody: Buffer;
  try {
    rawBody = await buffer(req as any);
  } catch {
    return errorResponse(res, 'Failed to read request body', 400);
  }
  try {
    (req as any).body = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : {};
  } catch {
    return errorResponse(res, 'Invalid JSON body', 400);
  }

  const { action } = req.body ?? {};

  try {
    switch (action) {
      case 'checkout':
        return await handleCheckout(req, res, uid, elapsed);
      case 'portal':
        return await handlePortal(req, res, uid, elapsed);
      case 'portal_change_plan':
        return await handlePortalPlanChange(req, res, uid, elapsed);
      default:
        return errorResponse(res, `Unknown action: "${action}". Valid actions: checkout, portal, portal_change_plan`, 400);
    }
  } catch (err: any) {
    logError('stripe_action_error', 'stripe', {
      uid, action, errorMessage: err?.message, statusCode: 500, durationMs: elapsed(),
    });
    return errorResponse(res, 'Stripe action failed', 500);
  }
}
