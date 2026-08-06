import type { VercelRequest, VercelResponse } from './types';
import { requireAdmin } from './require-admin';

/**
 * Splits a slash-separated collection path into normalized segments.
 * Trims whitespace and drops empty segments so that "users", "users/",
 * " users ", and "users//" all normalize to the same ["users"] — the
 * write/read authorization checks below key off these segments rather than
 * the raw path string, so they can't be bypassed by a stray slash the way
 * resolveCollection()'s own normalization previously allowed.
 */
export function parseCollectionPath(path: string): string[] {
  const segments = path.split('/').map((s) => s.trim()).filter(Boolean);

  if (segments.length === 0) {
    throw new Error('collection path must not be empty');
  }
  if (segments.length % 2 === 0) {
    throw new Error(
      `Invalid collection path "${path}": path has ${segments.length} segments but a collection path must have an odd number of segments (e.g. "col/docId/subCol").`
    );
  }

  return segments;
}

/** True when the normalized path is the top-level `users` collection itself. */
export function isUsersCollection(segments: string[]): boolean {
  return segments.length === 1 && segments[0] === 'users';
}

/**
 * When the normalized path is a sub-collection nested under a specific
 * users/{uid} document (e.g. "users/abc123/notes"), returns that uid.
 * Returns null for every other shape of path (including the top-level
 * `users` collection itself — use isUsersCollection() for that).
 */
export function usersSubcollectionOwner(segments: string[]): string | null {
  return segments[0] === 'users' && segments.length > 1 ? segments[1] : null;
}

/**
 * Fields on the `users` collection that are only ever set by server-side
 * logic (the Stripe webhook handler, the ask-ai quota counter) — never
 * accepted from a client-authored write, even from an admin caller editing
 * someone else's doc.
 */
export const ALWAYS_PROTECTED_USER_FIELDS = [
  'subscriptionStatus',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'currentPeriodEnd',
  'cancelAtPeriodEnd',
  'aiCallsToday',
  'aiCallsDate',
] as const;

/**
 * `subscriptionTier` doubles as the user's role (explorer/voyager/maestro/
 * vip/admin). It's protected on self-edits (no self-service privilege
 * escalation), but an admin caller editing someone else's doc is allowed to
 * set it — that's how the admin Users panel assigns the vip/admin tiers.
 */
export function stripProtectedUserFields(
  data: Record<string, unknown>,
  allowTierChange: boolean
): Record<string, unknown> {
  const cleaned = { ...data };
  for (const field of ALWAYS_PROTECTED_USER_FIELDS) {
    delete cleaned[field];
  }
  if (!allowTierChange) {
    delete cleaned.subscriptionTier;
  }
  return cleaned;
}

export type UsersDocAuthResult =
  | { ok: true; allowTierChange: boolean }
  | { ok: false };

/**
 * Authorizes access to a document owned by a specific Firebase uid — used
 * both for the top-level users/{targetUid} doc itself and for anything
 * nested under users/{targetUid}/... . Self-access is always allowed;
 * access to someone else's requires admin, and only then may the caller
 * change subscriptionTier (the admin Users panel's role-assignment flow).
 * On denial, writes the 403 response itself (mirroring requireAdmin).
 */
export async function authorizeUsersDocAccess(
  targetUid: string,
  uid: string,
  req: VercelRequest,
  res: VercelResponse
): Promise<UsersDocAuthResult> {
  if (targetUid === uid) {
    return { ok: true, allowTierChange: false };
  }
  if (!(await requireAdmin(uid, req, res))) {
    return { ok: false };
  }
  return { ok: true, allowTierChange: true };
}

/**
 * Authorizes a write (update/delete) to a document in a collection with no
 * special-cased ownership model. Ownership is read off whichever of
 * `createdBy` (docs created via POST /api/firestore) or `userId` (docs
 * created via POST /api/storage, e.g. `files`) is present. Fails closed:
 * a document with neither field set is treated as unowned and only an
 * admin may write to it — previously this case fell through and let *any*
 * authenticated caller write to it. On denial, writes the 403 response.
 */
export async function authorizeGenericDocWrite(
  docData: Record<string, unknown> | undefined,
  uid: string,
  req: VercelRequest,
  res: VercelResponse
): Promise<boolean> {
  const ownerId = (docData?.createdBy ?? docData?.userId) as string | undefined;
  if (ownerId === uid) {
    return true;
  }
  return requireAdmin(uid, req, res);
}

/**
 * Authorizes reading a document in a collection with no special-cased
 * ownership model. Unlike authorizeGenericDocWrite, a document with
 * neither `createdBy` nor `userId` set is treated as shared/public content
 * and allowed through — most non-`users` collections (word lists, exam
 * exercises, etc.) aren't ownership-scoped at all, and reads shouldn't fail
 * closed the way writes do. A document that *does* declare an owner is
 * restricted to that owner (or an admin) — this is what closes the IDOR
 * that let any authenticated caller read e.g. another user's `files` doc
 * (owner field `userId`) by guessing or enumerating its id.
 */
export async function authorizeGenericDocRead(
  docData: Record<string, unknown> | undefined,
  uid: string,
  req: VercelRequest,
  res: VercelResponse
): Promise<boolean> {
  const ownerId = (docData?.createdBy ?? docData?.userId) as string | undefined;
  if (ownerId === undefined || ownerId === uid) {
    return true;
  }
  return requireAdmin(uid, req, res);
}

/**
 * Authorizes reading from a users-scoped path: the top-level `users`
 * collection (single-doc fetch or filtered query) and anything nested
 * under users/{targetUid}/... . Own data is always readable; anything
 * else (including browsing/querying the whole `users` collection) requires
 * admin. Returns true immediately for paths outside the `users` scope —
 * those just need the caller to be authenticated, which the handler has
 * already verified before calling this.
 */
export async function authorizeUsersScopedRead(
  segments: string[],
  targetDocId: string | undefined,
  uid: string,
  req: VercelRequest,
  res: VercelResponse
): Promise<boolean> {
  if (isUsersCollection(segments)) {
    if (targetDocId !== undefined && targetDocId === uid) {
      return true;
    }
    return requireAdmin(uid, req, res);
  }

  const subOwner = usersSubcollectionOwner(segments);
  if (subOwner !== null) {
    if (subOwner === uid) {
      return true;
    }
    return requireAdmin(uid, req, res);
  }

  return true;
}
