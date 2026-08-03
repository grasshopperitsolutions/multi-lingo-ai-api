import type { VercelRequest, VercelResponse } from './types';
import { db } from './firebase-admin';
import { errorResponse } from './response';
import { logWarn } from './logger';

/**
 * Verifies that `uid` belongs to a user whose users/{uid} Firestore doc has
 * subscriptionTier === 'admin' — the same "hidden tier" convention the
 * frontend's useTierAccess()/isAdmin already relies on (see tierLimits.js).
 * There is no separate custom-claims mechanism in this codebase; admin
 * status lives entirely on the Firestore doc.
 *
 * Writes a 403 response and returns false when the caller isn't an admin.
 */
export async function requireAdmin(
  uid: string,
  req: VercelRequest,
  res: VercelResponse
): Promise<boolean> {
  const doc = await db.collection('users').doc(uid).get();
  const isAdmin = doc.exists && doc.data()?.subscriptionTier === 'admin';

  if (!isAdmin) {
    logWarn('admin_access_denied', 'require-admin', { uid, method: req.method });
    errorResponse(res, 'Admin access required', 403);
    return false;
  }

  return true;
}
