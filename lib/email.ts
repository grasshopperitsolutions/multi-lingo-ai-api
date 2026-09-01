/**
 * Resend adapter.
 *
 * A thin fetch against the Resend REST API rather than the `resend` SDK —
 * sending an email is a single POST, and this keeps the dependency list (and
 * its version churn) unchanged. Same "thin, independently swappable adapter"
 * shape as lib/providers/*.ts; swapping provider means rewriting only the
 * body of sendEmail().
 *
 * Env is read lazily inside the functions (the lib/providers/perplexity.ts
 * pattern) rather than asserted at module load (the lib/stripe.ts pattern),
 * so importing this module in a test needs no env setup.
 */

import { logInfo, logWarn } from './logger';
import { isSubscribed, type NotificationCategory } from './notification-prefs';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_BATCH_ENDPOINT = 'https://api.resend.com/emails/batch';

/** Resend's cap on messages per batch request. */
export const BATCH_MAX = 100;

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface SendContext {
  /** Template name, for logs. */
  template: string;
  /** Recipient uid, when known — logged (masked) and used for the preference check. */
  uid?: string;
  /**
   * Which category this send belongs to. `transactional` bypasses the
   * preference check; anything else is dropped when the user has opted out.
   */
  category: NotificationCategory;
  /**
   * Set only by a caller that has ALREADY applied the same opt-out check
   * against a user document it holds — the broadcast path, which has every
   * recipient's doc in hand and would otherwise re-read each one. Never set
   * this to skip the check itself.
   */
  prefsChecked?: boolean;
}

/** True when email sending is configured and not switched off. */
export function isEmailEnabled(): boolean {
  return !!process.env.RESEND_API_KEY && process.env.EMAIL_ENABLED !== 'false';
}

/**
 * Posts one message to Resend. Throws on a non-2xx response.
 * Prefer sendEmailSafe() at call sites — see below.
 */
export async function sendEmail(msg: EmailMessage): Promise<{ id: string } | null> {
  if (!isEmailEnabled()) {
    logInfo('email_skipped', 'email', { reason: 'email disabled or RESEND_API_KEY unset' });
    return null;
  }

  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM env variable is not set');

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toWirePayload(msg, from)),
  });

  if (!response.ok) {
    // Read the body for the log, but never surface it to the caller's
    // response — it can echo the recipient address back.
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend responded ${response.status}: ${detail.slice(0, 200)}`);
  }

  const json = (await response.json().catch(() => null)) as { id?: string } | null;
  return json?.id ? { id: json.id } : null;
}

/** Serializes one message into the wire shape Resend expects. */
function toWirePayload(msg: EmailMessage, from: string) {
  return {
    from,
    to: [msg.to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    reply_to: msg.replyTo ?? process.env.EMAIL_REPLY_TO ?? undefined,
  };
}

/**
 * Sends up to BATCH_MAX messages in a single request. Throws on a non-2xx.
 *
 * Why this exists: the account-wide rate limit is 10 requests/second, so
 * mailing a broadcast one request per recipient starts collecting 429s at
 * a few hundred users — and because sendEmailSafe never throws, those
 * recipients would be silently recorded as "skipped" rather than failing
 * loudly. One request per 100 recipients stays far under the limit and
 * inside the 120s function budget.
 *
 * Note this does NOT check per-user preferences — the caller must have
 * filtered the list already (see sendBatchSafe).
 */
export async function sendEmailBatch(messages: EmailMessage[]): Promise<number> {
  if (messages.length === 0) return 0;
  if (messages.length > BATCH_MAX) {
    throw new Error(`Batch of ${messages.length} exceeds the ${BATCH_MAX}-message limit`);
  }

  if (!isEmailEnabled()) {
    logInfo('email_batch_skipped', 'email', {
      count: messages.length,
      reason: 'email disabled or RESEND_API_KEY unset',
    });
    return 0;
  }

  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM env variable is not set');

  const response = await fetch(RESEND_BATCH_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    // The batch endpoint takes a bare JSON array, not an object wrapper.
    body: JSON.stringify(messages.map((msg) => toWirePayload(msg, from))),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend batch responded ${response.status}: ${detail.slice(0, 200)}`);
  }

  const json = (await response.json().catch(() => null)) as { data?: unknown[] } | null;
  // Resend returns one entry per accepted message; fall back to assuming the
  // whole batch landed if the shape ever changes, since a 2xx means accepted.
  return Array.isArray(json?.data) ? json.data.length : messages.length;
}

/**
 * Chunks `messages` into BATCH_MAX-sized requests and sends them in
 * sequence. Never throws; returns how many messages were accepted.
 *
 * Sequential rather than parallel on purpose: five chunked requests one
 * after another is nowhere near the rate limit, and a failed chunk should
 * not take the rest of the broadcast down with it.
 */
export async function sendBatchSafe(
  messages: EmailMessage[],
  context: Omit<SendContext, 'uid'>
): Promise<number> {
  let sent = 0;

  for (let i = 0; i < messages.length; i += BATCH_MAX) {
    const chunk = messages.slice(i, i + BATCH_MAX);
    try {
      sent += await sendEmailBatch(chunk);
    } catch (err: any) {
      logWarn('email_batch_failed', 'email', {
        template: context.template,
        category: context.category,
        count: chunk.length,
        errorMessage: err?.message,
      });
    }
  }

  if (sent > 0) {
    logInfo('email_batch_sent', 'email', {
      template: context.template,
      category: context.category,
      sent,
      total: messages.length,
    });
  }
  return sent;
}

/**
 * sendEmail() plus the two things every call site needs: the opt-out check,
 * and never throwing.
 *
 * Nothing in this codebase should fail a user-visible operation because mail
 * failed — a bad Resend key must not 500 a sign-in or abort an account
 * deletion. Same best-effort posture as the Stripe cancel in
 * lib/delete-user-account.ts.
 *
 * Returns null when skipped, opted out, or failed.
 */
export async function sendEmailSafe(
  msg: EmailMessage,
  context: SendContext
): Promise<{ id: string } | null> {
  try {
    if (!context.prefsChecked && context.uid && !(await isSubscribed(context.uid, context.category, 'email'))) {
      logInfo('email_opted_out', 'email', {
        uid: context.uid,
        template: context.template,
        category: context.category,
      });
      return null;
    }

    const result = await sendEmail(msg);
    if (result) {
      // Deliberately no recipient address and no body in the log line.
      logInfo('email_sent', 'email', {
        uid: context.uid,
        template: context.template,
        category: context.category,
        emailId: result.id,
      });
    }
    return result;
  } catch (err: any) {
    logWarn('email_failed', 'email', {
      uid: context.uid,
      template: context.template,
      category: context.category,
      errorMessage: err?.message,
    });
    return null;
  }
}
