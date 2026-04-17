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
    const { email } = req.body;

    // If email is provided, send password reset email
    if (email) {
      const actionCodeSettings = {
        url: process.env.PASSWORD_RESET_URL || 'https://your-app.com/reset-password',
        handleCodeInApp: true
      };

      await auth.generatePasswordResetLink(email, actionCodeSettings);
      
      return successResponse(res, {
        message: 'Password reset email sent',
        email
      });
    }

    return errorResponse(res, 'Email is required', 400);

  } catch (error: any) {
    return errorResponse(res, error.message || 'Password reset failed', 400);
  }
}