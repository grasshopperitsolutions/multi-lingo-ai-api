import type { VercelRequest, VercelResponse } from '../../lib/types';
import { auth, db, FieldValue } from '../../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const { idToken, accessToken } = req.body;

    if (!idToken) {
      return errorResponse(res, 'Apple ID token is required', 400);
    }

    // Verify the Apple ID token
    const decodedToken = await auth.verifyIdToken(idToken);
    const { uid, email, name } = decodedToken;

    // Check if user exists in Firestore
    const userDoc = await db.collection('users').doc(uid).get();

    if (!userDoc.exists) {
      // Create new user profile
      await db.collection('users').doc(uid).set({
        email: email || null,
        displayName: name || '',
        photoURL: null,
        provider: 'apple',
        emailVerified: !!email,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    } else {
      // Update last login
      await userDoc.ref.update({
        updatedAt: FieldValue.serverTimestamp(),
        lastLoginAt: FieldValue.serverTimestamp()
      });
    }

    // Create custom token for session
    const customToken = await auth.createCustomToken(uid);

    return successResponse(res, {
      uid,
      email,
      displayName: name,
      photoURL: null,
      customToken,
      isNewUser: !userDoc.exists
    });

  } catch (error: any) {
    return errorResponse(res, error.message || 'Apple authentication failed', 401);
  }
}