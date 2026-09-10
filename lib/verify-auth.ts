import type { VercelRequest, VercelResponse } from './types';
import { auth } from './firebase-admin';
import { errorResponse } from './response';
import { logWarn, logError } from './logger';

/** A verified caller: the uid, plus whether it belongs to a real account. */
export interface AuthSession {
  uid: string;
  /**
   * True for Firebase anonymous sessions. The public pages sign in
   * anonymously (getTokenOrAnonymous) so guests can read config and use the
   * contact form, which means a uid alone can't tell a person from a
   * throwaway browser session — every anonymous visit mints a fresh one.
   */
  isAnonymous: boolean;
}

/**
 * Verifies the Bearer token in the Authorization header.
 * Returns the decoded uid on success, or writes a 401 and returns null.
 *
 * Use verifyAuthSession() instead when the caller needs to distinguish a
 * signed-in user from an anonymous guest.
 */
export async function verifyAuth(
  req: VercelRequest,
  res: VercelResponse
): Promise<string | null> {
  const session = await verifyAuthSession(req, res);
  return session?.uid ?? null;
}

/**
 * As verifyAuth(), but also reports whether the session is anonymous.
 */
export async function verifyAuthSession(
  req: VercelRequest,
  res: VercelResponse
): Promise<AuthSession | null> {
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
    return {
      uid: decoded.uid,
      isAnonymous: decoded.firebase?.sign_in_provider === 'anonymous',
    };
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
