import type { VercelRequest, VercelResponse } from './types';
import { auth } from './firebase-admin';
import { errorResponse } from './response';
import { logWarn, logError } from './logger';

/**
 * Verifies the Bearer token in the Authorization header.
 * Returns the decoded uid on success, or writes a 401 and returns null.
 */
export async function verifyAuth(
  req: VercelRequest,
  res: VercelResponse
): Promise<string | null> {
  const authHeader = req.headers['authorization'] as string | undefined;

  if (!authHeader?.startsWith('Bearer ')) {
    logWarn('auth_header_missing', 'verify-auth', {
      method: req.method,
      reason: 'Authorization header absent or not Bearer',
    });
    errorResponse(res, 'Missing or invalid Authorization header', 401);
    return null;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = await auth.verifyIdToken(token);
    return decoded.uid;
  } catch (err: any) {
    logWarn('auth_token_invalid', 'verify-auth', {
      method: req.method,
      reason: err?.message ?? 'unknown',
      errorCode: err?.code ?? undefined,
    });
    errorResponse(res, 'Invalid or expired token', 401);
    return null;
  }
}
