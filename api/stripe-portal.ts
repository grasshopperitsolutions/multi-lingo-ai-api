import Stripe from 'stripe';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { db } from '../lib/firebase-admin';
import { logInfo, logError, startTimer } from '../lib/logger';
import type { VercelRequest, VercelResponse } from '../lib/types';

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

  try {
    const userDoc = await db.collection('users').doc(uid).get();
    const stripeCustomerId = userDoc.data()?.stripeCustomerId;

    if (!stripeCustomerId) {
      return errorResponse(res, 'No active subscription found', 404);
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${FRONTEND_URL}/settings`,
    });

    logInfo('stripe_portal_created', 'stripe-portal', {
      uid,
      statusCode: 200,
      durationMs: elapsed(),
    });

    return successResponse(res, { url: portalSession.url });
  } catch (err: any) {
    logError('stripe_portal_error', 'stripe-portal', {
      uid,
      statusCode: 500,
      durationMs: elapsed(),
      errorMessage: err?.message,
    });
    return errorResponse(res, err?.message ?? 'Failed to create portal session', 500);
  }
}
