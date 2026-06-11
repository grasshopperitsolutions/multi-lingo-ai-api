import Stripe from 'stripe';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { db, FieldValue } from '../lib/firebase-admin';
import { logInfo, logError, startTimer } from '../lib/logger';
import type { VercelRequest, VercelResponse, StripeCheckoutRequest } from '../lib/types';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-05-28.basil',
});

const FRONTEND_URL = process.env.FRONTEND_URL!;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleCors(req, res)) return;

  const elapsed = startTimer();

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const { priceId } = req.body as StripeCheckoutRequest;

  if (!priceId) {
    return errorResponse(res, 'Missing required field: priceId', 400);
  }

  try {
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.data() ?? {};

    let stripeCustomerId: string = userData.stripeCustomerId ?? '';

    // Create a Stripe Customer if one does not exist yet
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        metadata: { firebaseUid: uid },
        ...(userData.email ? { email: userData.email } : {}),
      });
      stripeCustomerId = customer.id;

      // Persist immediately so concurrent requests don't create duplicates
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

    logInfo('stripe_checkout_created', 'stripe-checkout', {
      uid,
      priceId,
      sessionId: session.id,
      statusCode: 200,
      durationMs: elapsed(),
    });

    return successResponse(res, { url: session.url });
  } catch (err: any) {
    logError('stripe_checkout_error', 'stripe-checkout', {
      uid,
      priceId,
      statusCode: 500,
      durationMs: elapsed(),
      errorMessage: err?.message,
    });
    return errorResponse(res, err?.message ?? 'Failed to create checkout session', 500);
  }
}
