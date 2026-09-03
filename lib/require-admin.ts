import type { VercelRequest, VercelResponse } from './types';
import { db } from './firebase-admin';
import { errorResponse } from './response';
import { logWarn } from './logger';

/**
 * True when `uid` belongs to a user whose users/{uid} Firestore doc has
 * subscriptionTier === 'admin' — the same "hidden tier" convention the
 * frontend's useTierAccess()/isAdmin already relies on (see tierLimits.js).
 * There is no separate custom-claims mechanism in this codebase; admin
 * status lives entirely on the Firestore doc.
 *
 * Answers the question without writing a response, for the callers that
 * need to *widen* a result rather than reject a request — see
 * filterQueryResultsByOwnership() in lib/firestore-helpers.ts. Use
 * requireAdmin() for the ordinary "deny unless admin" gate.
 */
export async function isAdmin(uid: string): Promise<boolean> {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists && doc.data()?.subscriptionTier === 'admin';
}

/**
 * Admin gate for a request: writes a 403 response and returns false when
 * the caller isn't an admin.
 */
export async function requireAdmin(
  uid: string,
  req: VercelRequest,
  res: VercelResponse
): Promise<boolean> {
  if (!(await isAdmin(uid))) {
    logWarn('admin_access_denied', 'require-admin', { uid, method: req.method });
    errorResponse(res, 'Admin access required', 403);
    return false;
  }

  return true;
}
