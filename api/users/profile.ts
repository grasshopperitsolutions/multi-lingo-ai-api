import type { VercelRequest, VercelResponse } from '../../lib/types';
import { auth, db, FieldValue } from '../../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return errorResponse(res, 'User ID is required', 401);
  }

  try {
    if (req.method === 'GET') {
      // Get user profile
      const userDoc = await db.collection('users').doc(userId).get();

      if (!userDoc.exists) {
        return errorResponse(res, 'User profile not found', 404);
      }

      const userRecord = await auth.getUser(userId);

      return successResponse(res, {
        uid: userRecord.uid,
        email: userRecord.email,
        emailVerified: userRecord.emailVerified,
        displayName: userRecord.displayName,
        photoURL: userRecord.photoURL,
        providerData: userRecord.providerData.map(p => ({
          providerId: p.providerId,
          email: p.email,
          displayName: p.displayName,
          photoURL: p.photoURL
        })),
        profile: userDoc.data(),
        createdAt: userRecord.metadata.creationTime,
        lastLoginAt: userRecord.metadata.lastSignInTime
      });

    } else if (req.method === 'PUT') {
      const { displayName, photoURL, ...otherData } = req.body;

      if (displayName !== undefined || photoURL !== undefined) {
        await auth.updateUser(userId, {
          displayName: displayName || undefined,
          photoURL: photoURL || undefined
        });
      }

      const updateData = {
        ...otherData,
        displayName: displayName || undefined,
        photoURL: photoURL || undefined,
        updatedAt: FieldValue.serverTimestamp()
      };

      await db.collection('users').doc(userId).update(updateData);

      return successResponse(res, {
        message: 'Profile updated successfully',
        displayName,
        photoURL
      });

    } else {
      return errorResponse(res, 'Method not allowed', 405);
    }

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to process profile request', 500);
  }
}