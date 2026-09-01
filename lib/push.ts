/**
 * Web push via Firebase Cloud Messaging.
 *
 * FCM rather than raw Web Push + VAPID: firebase-admin is already a
 * dependency here and the frontend already has the Firebase SDK, so this
 * adds no packages on either side. The browser gets its token from
 * firebase/messaging and stores it on its own user document; this module
 * reads those tokens back and sends to them.
 *
 * Tokens live on `users/{uid}.fcmTokens` (an array). They are per-browser,
 * not per-user, so a user with a laptop and a phone has two. FCM rejects
 * tokens that have expired or whose browser revoked permission — those are
 * pruned here on the next send rather than accumulating forever.
 */

import { getMessaging, db, FieldValue } from './firebase-admin';
import { logInfo, logWarn } from './logger';
import { normalizePrefs, type NotificationCategory } from './notification-prefs';

/** FCM error codes meaning "this token is dead, stop using it". */
const DEAD_TOKEN_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
];

export interface PushMessage {
  title: string;
  body: string;
  /** Path the browser opens on click, e.g. '/dashboard'. */
  link?: string;
}

export interface PushContext {
  template: string;
  category: NotificationCategory;
}

export function isPushEnabled(): boolean {
  return process.env.PUSH_ENABLED !== 'false';
}

/**
 * True when `userData` (an already-fetched users/{uid} document body) has
 * opted in to `category` over push. Exported so a caller holding the doc —
 * the broadcast path — can filter without re-reading it.
 */
export function isPushSubscribed(userData: unknown, category: NotificationCategory): boolean {
  if (category === 'transactional') return true;
  const prefs = normalizePrefs((userData as Record<string, unknown>)?.notificationPrefs);
  return prefs[category]?.push === true;
}

/**
 * Sends one push to every live token `uid` has registered, honouring the
 * user's opt-out and pruning dead tokens. Never throws.
 *
 * Returns the number of devices actually reached (0 when opted out, when the
 * user has no tokens, or on failure) — push is best-effort by nature: a user
 * can revoke permission at the OS level at any time without telling us.
 */
export async function sendPushSafe(
  uid: string,
  msg: PushMessage,
  context: PushContext
): Promise<number> {
  try {
    if (!isPushEnabled()) {
      logInfo('push_skipped', 'push', { uid, reason: 'PUSH_ENABLED=false' });
      return 0;
    }

    // One read for both the opt-out check and the tokens — they live on the
    // same document, so going through isSubscribed() would read it twice.
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return 0;

    if (!isPushSubscribed(snap.data(), context.category)) {
      logInfo('push_opted_out', 'push', { uid, template: context.template, category: context.category });
      return 0;
    }

    return await sendPushToTokens(uid, (snap.data()?.fcmTokens ?? []) as string[], msg, context);
  } catch (err: any) {
    logWarn('push_failed', 'push', { uid, template: context.template, errorMessage: err?.message });
    return 0;
  }
}

/**
 * Delivers to an explicit token list, pruning any FCM rejects as dead.
 * Use this when the caller already holds the user's document (and has
 * already applied isPushSubscribed to it); sendPushSafe wraps it for the
 * ordinary single-user case.
 */
export async function sendPushToTokens(
  uid: string,
  tokens: string[],
  msg: PushMessage,
  context: PushContext
): Promise<number> {
  try {
    if (!isPushEnabled() || tokens.length === 0) return 0;

    const response = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: msg.title, body: msg.body },
      // The service worker reads `link` from the data payload to decide
      // where to navigate on click; `notification` alone can't carry it.
      data: { link: msg.link ?? '/dashboard' },
      webpush: {
        fcmOptions: { link: msg.link ?? '/dashboard' },
      },
    });

    const dead = response.responses
      .map((r, i) => (!r.success && DEAD_TOKEN_CODES.includes(r.error?.code ?? '') ? tokens[i] : null))
      .filter((t): t is string => t !== null);

    if (dead.length > 0) {
      await db.collection('users').doc(uid).update({
        fcmTokens: FieldValue.arrayRemove(...dead),
      });
      logInfo('push_tokens_pruned', 'push', { uid, count: dead.length });
    }

    logInfo('push_sent', 'push', {
      uid,
      template: context.template,
      category: context.category,
      succeeded: response.successCount,
      failed: response.failureCount,
    });

    return response.successCount;
  } catch (err: any) {
    logWarn('push_failed', 'push', { uid, template: context.template, errorMessage: err?.message });
    return 0;
  }
}
