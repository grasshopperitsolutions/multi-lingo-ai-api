/**
 * Notification categories and per-user delivery preferences.
 *
 * Preferences live on the user's own `users/{uid}.notificationPrefs` field,
 * which is deliberately NOT in ALWAYS_PROTECTED_USER_FIELDS: a user editing
 * their own settings must be able to write it through the generic
 * PUT /api/firestore path, the same way they edit `theme` or `interfaceLang`.
 *
 * The check itself is enforced HERE, server-side, at send time — never in
 * the frontend. An opt-out that only hid a toggle in the UI would still let
 * a bug (or an admin broadcast) mail someone who asked not to be mailed.
 */

import { db } from './firebase-admin';

/**
 * - `transactional` — billing, account, and security mail. NOT opt-outable:
 *   a user must always receive a payment-failure or account-deletion notice,
 *   and service messages of this kind are exempt from opt-out under both
 *   GDPR and CAN-SPAM. Never stored in notificationPrefs.
 * - `announcements` — admin broadcasts, product news. Opt-outable.
 * - `reminders`     — practice/streak nudges. Opt-outable. Nothing sends
 *   this category yet (scheduled sending is out of scope); the category
 *   exists so the preference UI and storage don't need reshaping later.
 */
export type NotificationCategory = 'transactional' | 'announcements' | 'reminders';

export type NotificationChannel = 'email' | 'push';

/** The categories a user can actually switch off. */
export const OPTIONAL_CATEGORIES = ['announcements', 'reminders'] as const;

export type NotificationPrefs = Record<string, { email: boolean; push: boolean }>;

/**
 * Email defaults to on (opt-out) for optional categories; push defaults to
 * off (opt-in) everywhere, because a browser notification is intrusive and
 * requires an explicit permission grant anyway.
 */
export const DEFAULT_PREFS: NotificationPrefs = {
  announcements: { email: true, push: false },
  reminders: { email: true, push: false },
};

/** Merges a stored (possibly partial or malformed) prefs object over the defaults. */
export function normalizePrefs(stored: unknown): NotificationPrefs {
  const result: NotificationPrefs = {
    announcements: { ...DEFAULT_PREFS.announcements },
    reminders: { ...DEFAULT_PREFS.reminders },
  };
  if (!stored || typeof stored !== 'object') return result;

  for (const category of OPTIONAL_CATEGORIES) {
    const value = (stored as Record<string, unknown>)[category];
    if (!value || typeof value !== 'object') continue;
    const { email, push } = value as Record<string, unknown>;
    if (typeof email === 'boolean') result[category].email = email;
    if (typeof push === 'boolean') result[category].push = push;
  }
  return result;
}

/**
 * True when `uid` should receive `category` over `channel`.
 *
 * Transactional always passes without a Firestore read. Anything else reads
 * the user's stored prefs; a missing user doc denies optional mail (there is
 * nobody to have consented) but a missing/partial prefs object falls back to
 * DEFAULT_PREFS.
 */
export async function isSubscribed(
  uid: string,
  category: NotificationCategory,
  channel: NotificationChannel
): Promise<boolean> {
  if (category === 'transactional') return true;

  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return false;

  return normalizePrefs(snap.data()?.notificationPrefs)[category]?.[channel] === true;
}
