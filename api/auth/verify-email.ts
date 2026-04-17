import type { VercelRequest, VercelResponse } from '../../lib/types';
import { auth, db } from '../../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';

const FIREBASE_AUTH_API_BASE = 'https://identitytoolkit.googleapis.com/v1';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const { oobCode } = req.body;

    if (!oobCode) {
      return errorResponse(res, 'Verification code is required', 400);
    }

    // Verify the OOB code using Firebase Auth REST API
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) {
      return errorResponse(res, 'Firebase API key not configured', 500);
    }

    const verifyResponse = await fetch(
      `${FIREBASE_AUTH_API_BASE}/accounts:verifyOobCode?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oobCode, mode: 'verifyEmail' }),
      }
    );

    const verifyResult = await verifyResponse.json();

    if (!verifyResponse.ok || verifyResult.error) {
      return errorResponse(
        res,
        verifyResult.error?.message || 'Invalid verification code',
        400
      );
    }

    const email = verifyResult.email;

    if (!email) {
      return errorResponse(res, 'Invalid verification code', 400);
    }

    // Get user record to update
    const userRecord = await auth.getUserByEmail(email);

    // Mark the user's email as verified
    await auth.updateUser(userRecord.uid, {
      emailVerified: true
    });

    // Update user's email verification status in Firestore
    await db.collection('users').doc(userRecord.uid).update({
      emailVerified: true,
      emailVerifiedAt: new Date().toISOString()
    });

    return successResponse(res, {
      message: 'Email verified successfully',
      emailVerified: true
    });

  } catch (error: any) {
    return errorResponse(res, error.message || 'Email verification failed', 400);
  }
}