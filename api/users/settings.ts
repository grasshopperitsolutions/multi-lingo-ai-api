import type { VercelRequest, VercelResponse } from '../../lib/types';
import { db, FieldValue } from '../../lib/firebase-admin';
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
    const settingsDocRef = db.collection('user_settings').doc(userId);

    if (req.method === 'GET') {
      const settingsDoc = await settingsDocRef.get();

      if (!settingsDoc.exists) {
        return successResponse(res, {
          settings: {
            language: 'en',
            notifications: {
              email: true,
              push: true
            },
            privacy: {
              profileVisible: true
            },
            theme: 'light'
          }
        });
      }

      return successResponse(res, {
        settings: settingsDoc.data()
      });

    } else if (req.method === 'PUT') {
      const settings = req.body;

      if (!settings || typeof settings !== 'object') {
        return errorResponse(res, 'Settings object is required', 400);
      }

      const updateData = {
        ...settings,
        updatedAt: FieldValue.serverTimestamp()
      };

      await settingsDocRef.set(updateData, { merge: true });

      return successResponse(res, {
        message: 'Settings updated successfully',
        settings: updateData
      });

    } else {
      return errorResponse(res, 'Method not allowed', 405);
    }

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to process settings request', 500);
  }
}