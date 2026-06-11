import Stripe from 'stripe';
import { setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { db, FieldValue } from '../lib/firebase-admin';
import { logInfo, logWarn, logError, startTimer } from '../lib/logger';
import type { VercelRequest, VercelResponse, SubscriptionTier } from '../lib/types';
import { buffer } from 'micro';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-05-28.basil',
});

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const elapsed = startTimer();

  // Stripe requires the raw body to validate the webhook signature
  let rawBody: Buffer;
  try {
    rawBody = await buffer(req as any);
  } catch (err: any) {
    return errorResponse(res, 'Failed to read request body', 400);
  }

  const sig = (req as any).headers['stripe-signature'];

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (err: any) {
    logWarn('stripe_webhook_invalid_sig', 'stripe-webhook', {
      errorMessage: err?.message,
      statusCode: 400,
      durationMs: elapsed(),
    });
    return errorResponse(res, `Webhook signature verification failed: ${err?.message}`, 400);
  }

  logInfo('stripe_webhook_received', 'stripe-webhook', {
    eventType: event.type,
    eventId: event.id,
    durationMs: elapsed(),
  });

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== 'subscription') break;

        const customerId = session.customer as string;
        const subscriptionId = session.subscription as string;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = subscription.items.data[0]?.price.id;
        const tier = tierFromPriceId(priceId);

        const uid = (session.metadata?.firebaseUid) ?? await uidFromCustomerId(customerId);

        if (!uid) {
          logWarn('stripe_webhook_uid_not_found', 'stripe-webhook', {
            customerId, eventType: event.type,
          });
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

        logInfo('stripe_webhook_activated', 'stripe-webhook', {
          uid, tier, subscriptionId, statusCode: 200, durationMs: elapsed(),
        });
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        const priceId = subscription.items.data[0]?.price.id;
        const tier = tierFromPriceId(priceId);

        const uid = await uidFromCustomerId(customerId);
        if (!uid) {
          logWarn('stripe_webhook_uid_not_found', 'stripe-webhook', {
            customerId, eventType: event.type,
          });
          break;
        }

        await db.collection('users').doc(uid).set({
          subscriptionTier: tier,
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        logInfo('stripe_webhook_updated', 'stripe-webhook', {
          uid, tier, status: subscription.status, durationMs: elapsed(),
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        const uid = await uidFromCustomerId(customerId);
        if (!uid) break;

        await db.collection('users').doc(uid).set({
          subscriptionTier: 'explorer',
          stripeSubscriptionId: null,
          subscriptionStatus: 'canceled',
          currentPeriodEnd: null,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        logInfo('stripe_webhook_canceled', 'stripe-webhook', {
          uid, durationMs: elapsed(),
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        const uid = await uidFromCustomerId(customerId);
        if (!uid) break;

        await db.collection('users').doc(uid).set({
          subscriptionStatus: 'past_due',
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        logWarn('stripe_webhook_payment_failed', 'stripe-webhook', {
          uid, durationMs: elapsed(),
        });
        break;
      }

      default:
        logInfo('stripe_webhook_ignored', 'stripe-webhook', {
          eventType: event.type, durationMs: elapsed(),
        });
    }

    return successResponse(res, { received: true });
  } catch (err: any) {
    logError('stripe_webhook_handler_error', 'stripe-webhook', {
      eventType: event.type,
      errorMessage: err?.message,
      statusCode: 500,
      durationMs: elapsed(),
    });
    return errorResponse(res, err?.message ?? 'Webhook handler failed', 500);
  }
}
