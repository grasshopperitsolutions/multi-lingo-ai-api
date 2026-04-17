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
    const userId = req.headers['x-user-id'] as string;

    if (!userId) {
      return errorResponse(res, 'User ID is required', 400);
    }

    // Revoke all refresh tokens for the user
    await auth.revokeRefreshTokens(userId);

    return successResponse(res, {
      message: 'Successfully logged out'
    });

  } catch (error: any) {
    return errorResponse(res, error.message || 'Logout failed', 500);
  }
}