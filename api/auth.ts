import { auth, db, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import type { VercelRequest, VercelResponse } from '../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);

  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const { action } = req.body;

    if (!action) {
      return errorResponse(res, 'Action is required', 400);
    }

    switch (action) {
      case 'logout': {
        // Logout is handled client-side by the Firebase client SDK.
        // This endpoint exists for any future server-side session cleanup.
        return successResponse(res, { message: 'Logged out successfully' });
      }

      case 'google':
      case 'apple':
      case 'facebook':
      case 'twitter': {
        const { idToken } = req.body;

        if (!idToken) {
          return errorResponse(res, 'ID token is required', 400);
        }

        // Verify the ID token issued by Firebase client SDK
        const decodedToken = await auth.verifyIdToken(idToken);

        // Get or create the Firebase Auth user record
        let userRecord;
        try {
          userRecord = await auth.getUser(decodedToken.uid);
        } catch {
          userRecord = await auth.createUser({
            uid: decodedToken.uid,
            email: decodedToken.email,
            displayName: decodedToken.name,
            photoURL: decodedToken.picture,
            emailVerified: decodedToken.email_verified
          });
        }

        // Check if the Firestore doc already exists
        const userDocRef = db.collection('users').doc(userRecord.uid);
        const userDocSnap = await userDocRef.get();

        if (!userDocSnap.exists) {
          // First login: create full profile with defaults
          await userDocRef.set({
            email: userRecord.email,
            displayName: userRecord.displayName || decodedToken.name || '',
            photoURL: userRecord.photoURL || decodedToken.picture || null,
            emailVerified: userRecord.emailVerified,
            provider: action,
            interfaceLang: 'en',
            theme: 'light',
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          // Returning user: refresh social fields only, preserve user preferences
          await userDocRef.update({
            displayName: userRecord.displayName || decodedToken.name || '',
            photoURL: userRecord.photoURL || decodedToken.picture || null,
            emailVerified: userRecord.emailVerified,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        // Issue a custom token so the client can call signInWithCustomToken
        const customToken = await auth.createCustomToken(userRecord.uid);

        return successResponse(res, {
          uid: userRecord.uid,
          email: userRecord.email,
          displayName: userRecord.displayName || decodedToken.name || '',
          photoURL: userRecord.photoURL || decodedToken.picture || null,
          customToken
        });
      }

      default:
        return errorResponse(res, 'Invalid action', 400);
    }

  } catch (error: any) {
    return errorResponse(res, error.message || 'Authentication failed', 401);
  }
}
