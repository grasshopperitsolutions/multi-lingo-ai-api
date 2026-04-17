import { auth, db } from '../../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';
import type { VercelRequest, VercelResponse } from '../../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return errorResponse(res, 'Email and password are required', 400);
    }

    // Get user by email
    const userRecord = await auth.getUserByEmail(email);
    
    // Create custom token
    const customToken = await auth.createCustomToken(userRecord.uid);
    
    // Get user profile from Firestore
    const userDoc = await db.collection('users').doc(userRecord.uid).get();
    const userProfile = userDoc.exists ? userDoc.data() : null;

    return successResponse(res, {
      uid: userRecord.uid,
      email: userRecord.email,
      displayName: userRecord.displayName,
      photoURL: userRecord.photoURL,
      customToken,
      profile: userProfile
    });

  } catch (error: any) {
    return errorResponse(res, error.message || 'Authentication failed', 401);
  }
}