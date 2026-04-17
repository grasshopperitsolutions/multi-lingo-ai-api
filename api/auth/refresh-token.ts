import type { VercelRequest, VercelResponse } from '../../lib/types';
import { auth } from '../../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return errorResponse(res, 'Refresh token is required', 400);
    }

    // Check token validity by verifying it
    const decodedToken = await auth.verifyIdToken(refreshToken);

    // Create new custom token
    const newCustomToken = await auth.createCustomToken(decodedToken.uid);

    return successResponse(res, {
      customToken: newCustomToken,
      expiresIn: 3600
    });

  } catch (error: any) {
    if (error.code === 'auth/id-token-expired' || error.code === 'auth/argument-error') {
      return errorResponse(res, 'Token expired or invalid', 401);
    }
    return errorResponse(res, error.message || 'Token refresh failed', 500);
  }
}