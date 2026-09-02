/**
 * POST /api/email — the one notification endpoint.
 *
 * Despite the name it covers both channels: an admin broadcast fans out to
 * email and web push from a single composer, and splitting that across two
 * endpoints would mean two round-trips and two partial-failure stories.
 * Everything else in the system sends its notifications inline from the
 * handler that owns the event (sign-in, the Stripe webhook, account
 * deletion) and needs no endpoint at all.
 *
 *   POST action: 'contact'   — public contact form -> CONTACT_INBOX
 *   POST action: 'broadcast' — admin-authored announcement -> users (admin only)
 *   GET                      — nightly unread-report digest, Vercel cron only
 */

import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { requireAdmin } from '../lib/require-admin';
import { db, FieldValue } from '../lib/firebase-admin';
import { logInfo, logWarn, logError, startTimer } from '../lib/logger';
import { sendEmailSafe, sendBatchSafe, type EmailMessage } from '../lib/email';
import { sendPushToTokens, isPushSubscribed } from '../lib/push';
import { getEmailCopy } from '../lib/email-copy';
import { contactFormEmail, broadcastEmail, reportDigestEmail } from '../lib/email-templates';
import { normalizePrefs } from '../lib/notification-prefs';
import type { VercelRequest, VercelResponse } from '../lib/types';

const VALID_CONTACT_SUBJECTS = ['general', 'support', 'feedback', 'business', 'bug'];

const MAX_NAME = 200;
const MAX_MESSAGE = 5000;
const MAX_BROADCAST_SUBJECT = 200;
const MAX_BROADCAST_BODY = 10000;

/** Contact submissions allowed per uid per hour. */
const CONTACT_RATE_LIMIT = 3;
const CONTACT_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Hard ceiling on one broadcast. Email now goes out 100 per request, so the
 * 120s function budget is no longer the binding constraint — the Resend free
 * tier's 100 emails/day is. A larger audience needs a queue and a cron,
 * deliberately not built here. Failing loudly beats half-sending and leaving
 * no record of who got it.
 */
const MAX_BROADCAST_RECIPIENTS = 500;

/** Parallel push sends. Email goes out in batches instead (see sendBatchSafe). */
const SEND_CONCURRENCY = 5;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Runs `worker` over `items` with a fixed-size pool, preserving nothing but the counts. */
async function pooled<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

// ─────────────────────────────────────────────────────────────────────────────
// contact
// ─────────────────────────────────────────────────────────────────────────────

async function handleContact(req: VercelRequest, res: VercelResponse, uid: string, elapsed: () => number) {
  const name = asString(req.body?.name);
  const email = asString(req.body?.email);
  const phone = asString(req.body?.phone);
  const subject = asString(req.body?.subject) || 'general';
  const message = asString(req.body?.message);

  if (!name || !email || !message) {
    return errorResponse(res, 'Name, email and message are required', 400);
  }
  if (!VALID_CONTACT_SUBJECTS.includes(subject)) {
    return errorResponse(res, 'Invalid subject', 400);
  }
  if (name.length > MAX_NAME || email.length > MAX_NAME || phone.length > MAX_NAME) {
    return errorResponse(res, 'Name, email or phone is too long', 400);
  }
  if (message.length > MAX_MESSAGE) {
    return errorResponse(res, `Message must be ${MAX_MESSAGE} characters or fewer`, 400);
  }
  // Deliberately loose: real address validation is delivery, not a regex.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return errorResponse(res, 'Invalid email address', 400);
  }

  const inbox = process.env.CONTACT_INBOX;
  if (!inbox) {
    logError('contact_inbox_unset', 'email', { uid, statusCode: 500, durationMs: elapsed() });
    return errorResponse(res, 'Failed to send message', 500);
  }

  // Rate limit per caller. Anonymous sessions each get their own uid, so
  // this throttles a browser rather than a person — enough to stop casual
  // form-hammering without blocking a genuine follow-up message.
  //
  // A fixed window in a single counter document, rather than a
  // where(uid).where(createdAt >=) query over the submissions: an equality
  // plus an inequality on a different field needs a composite index in
  // Firestore, which would fail on first use in production until someone
  // clicked through the console. One doc read is also cheaper.
  const limiterRef = db.collection('contactRateLimits').doc(uid);
  const limiter = await limiterRef.get();
  const windowStart = (limiter.data()?.windowStart as number | undefined) ?? 0;
  const windowIsOpen = Date.now() - windowStart < CONTACT_RATE_WINDOW_MS;
  const used = windowIsOpen ? ((limiter.data()?.count as number | undefined) ?? 0) : 0;

  if (used >= CONTACT_RATE_LIMIT) {
    logWarn('contact_rate_limited', 'email', { uid, statusCode: 429, durationMs: elapsed() });
    return errorResponse(res, 'Too many messages sent recently. Please try again later.', 429);
  }

  await limiterRef.set(
    { count: used + 1, windowStart: windowIsOpen ? windowStart : Date.now() },
    { merge: true }
  );

  // Persist first: a submission that survives a provider outage can still be
  // read out of Firestore, which is the whole reason the old fake-submit was
  // so damaging — those messages left no trace anywhere.
  const submissionRef = await db.collection('contactSubmissions').add({
    uid, name, email, phone: phone || null, subject, message,
    createdAt: FieldValue.serverTimestamp(),
    emailId: null,
  });

  const result = await sendEmailSafe(
    contactFormEmail(inbox, { name, email, phone, subject, message, uid }),
    { template: 'contact', category: 'transactional' }
  );

  if (result?.id) {
    await submissionRef.update({ emailId: result.id });
  }

  logInfo('contact_submitted', 'email', {
    uid, subject, delivered: !!result, statusCode: 200, durationMs: elapsed(),
  });

  // The message is stored either way, so the user is told it was received
  // even if the provider call failed — it was.
  return successResponse(res, { received: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// broadcast
// ─────────────────────────────────────────────────────────────────────────────

async function handleBroadcast(req: VercelRequest, res: VercelResponse, uid: string, elapsed: () => number) {
  if (!(await requireAdmin(uid, req, res))) return;

  const subject = asString(req.body?.subject);
  const body = asString(req.body?.body);
  const mode = asString(req.body?.mode);
  const sendEmail = req.body?.channels?.email === true;
  const sendPush = req.body?.channels?.push === true;

  if (!subject || !body) return errorResponse(res, 'Subject and body are required', 400);
  if (subject.length > MAX_BROADCAST_SUBJECT) return errorResponse(res, 'Subject is too long', 400);
  if (body.length > MAX_BROADCAST_BODY) return errorResponse(res, 'Body is too long', 400);
  if (!sendEmail && !sendPush) return errorResponse(res, 'Pick at least one channel', 400);

  // Resolve the audience.
  let recipients: Array<{ uid: string; data: FirebaseFirestore.DocumentData }>;

  if (mode === 'user') {
    const targetUid = asString(req.body?.uid);
    if (!targetUid) return errorResponse(res, 'A target uid is required', 400);
    const doc = await db.collection('users').doc(targetUid).get();
    if (!doc.exists) {
      // Logged with the value actually looked up. The composer once sent a
      // display name here, because listAllUserProfiles() renames the
      // document id to `uid` and the <option> was reading a non-existent
      // `id` — which 404s identically to a genuinely missing user.
      logWarn('broadcast_target_not_found', 'email', {
        uid, targetUid, statusCode: 404, durationMs: elapsed(),
      });
      return errorResponse(res, 'User not found', 404);
    }
    recipients = [{ uid: doc.id, data: doc.data()! }];
  } else {
    let query: FirebaseFirestore.Query = db.collection('users');

    if (mode === 'tier') {
      const tier = asString(req.body?.tier);
      if (!tier) return errorResponse(res, 'A tier is required', 400);
      query = query.where('subscriptionTier', '==', tier);
    } else if (mode === 'all') {
      // Second interlock behind the composer's typed confirmation: an
      // accidental or replayed call can't reach every user without this.
      if (asString(req.body?.confirm) !== 'ALL') {
        return errorResponse(res, 'Broadcasting to all users requires confirm: "ALL"', 400);
      }
    } else {
      return errorResponse(res, 'mode must be one of: user, tier, all', 400);
    }

    const snapshot = await query.limit(MAX_BROADCAST_RECIPIENTS + 1).get();
    if (snapshot.size > MAX_BROADCAST_RECIPIENTS) {
      return errorResponse(
        res,
        `Audience exceeds the ${MAX_BROADCAST_RECIPIENTS}-recipient limit for a single broadcast`,
        400
      );
    }
    recipients = snapshot.docs.map((doc) => ({ uid: doc.id, data: doc.data() }));
  }

  const stats = { total: recipients.length, emailSent: 0, emailSkipped: 0, pushSent: 0, pushSkipped: 0 };

  if (sendEmail) {
    // Build every message first, then hand the whole list to sendBatchSafe,
    // which chunks it into 100-message requests. One request per recipient
    // would blow past Resend's 10-req/s account limit partway through a large
    // broadcast, and because sendEmailSafe never throws, those 429s would
    // have been recorded as ordinary skips rather than surfacing as failures.
    //
    // The opt-out is applied here, from documents already in hand: the batch
    // endpoint has no per-message preference check of its own.
    const messages: EmailMessage[] = [];
    for (const { data } of recipients) {
      const optedIn = normalizePrefs(data.notificationPrefs).announcements?.email === true;
      if (!optedIn || !data.email) {
        stats.emailSkipped++;
        continue;
      }
      const copy = await getEmailCopy(data.interfaceLang);
      messages.push(broadcastEmail(copy, data.email as string, subject, body));
    }

    stats.emailSent = await sendBatchSafe(messages, {
      template: 'broadcast',
      category: 'announcements',
    });
    // Whatever the provider didn't accept is a skip, not a silent success.
    stats.emailSkipped += messages.length - stats.emailSent;
  }

  if (sendPush) {
    // Push stays per recipient: FCM has no cross-user batch equivalent
    // (sendEachForMulticast only batches one user's own devices), and its
    // quotas are far higher than Resend's.
    await pooled(recipients, SEND_CONCURRENCY, async ({ uid: recipientUid, data }) => {
      const tokens = (data.fcmTokens ?? []) as string[];
      if (!isPushSubscribed(data, 'announcements') || tokens.length === 0) {
        stats.pushSkipped++;
        return;
      }
      const reached = await sendPushToTokens(
        recipientUid, tokens,
        { title: subject, body: body.slice(0, 300), link: '/dashboard' },
        { template: 'broadcast', category: 'announcements' }
      );
      reached > 0 ? stats.pushSent++ : stats.pushSkipped++;
    });
  }

  logInfo('broadcast_sent', 'email', {
    uid, mode, ...stats, statusCode: 200, durationMs: elapsed(),
  });

  return successResponse(res, stats);
}

// ─────────────────────────────────────────────────────────────────────────────
// nightly report digest (Vercel cron)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/email — how many user reports are still unread.
 *
 * Wired to a nightly cron in vercel.json. Vercel sends CRON_SECRET as a
 * Bearer token on the invocation, which is the only thing authorizing this;
 * there is no Firebase session on a cron request.
 *
 * Sends nothing when the count is zero — a nightly "you have 0 reports" mail
 * trains you to ignore the ones that matter.
 */
async function handleReportDigest(req: VercelRequest, res: VercelResponse, elapsed: () => number) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'];

  if (!secret || authHeader !== `Bearer ${secret}`) {
    logWarn('cron_unauthorized', 'email', { statusCode: 401, durationMs: elapsed() });
    return errorResponse(res, 'Unauthorized', 401);
  }

  // Vercel cron delivery is best-effort and can fire the same run twice.
  // A date stamp makes a duplicate invocation a no-op rather than a second
  // identical email.
  const today = new Date().toISOString().slice(0, 10);
  const runRef = db.collection('cronRuns').doc('report_digest');
  const lastRun = (await runRef.get()).data()?.lastRunDate;

  if (lastRun === today) {
    logInfo('cron_already_ran', 'email', { job: 'report_digest', today, durationMs: elapsed() });
    return successResponse(res, { skipped: 'already ran today' });
  }

  const snapshot = await db
    .collection('appConfig').doc('config')
    .collection('reports')
    .where('read', '==', false)
    .get();

  const unreadCount = snapshot.size;

  // Claim the day even when nothing is sent, so a retry doesn't re-query.
  await runRef.set({ lastRunDate: today, unreadCount, ranAt: FieldValue.serverTimestamp() }, { merge: true });

  if (unreadCount === 0) {
    logInfo('report_digest_skipped', 'email', { reason: 'no unread reports', durationMs: elapsed() });
    return successResponse(res, { unreadCount, sent: false });
  }

  const inbox = process.env.CONTACT_INBOX;
  if (!inbox) {
    logError('contact_inbox_unset', 'email', { statusCode: 500, durationMs: elapsed() });
    return errorResponse(res, 'Digest could not be sent', 500);
  }

  const byCategory: Record<string, number> = {};
  for (const doc of snapshot.docs) {
    const category = (doc.data().category as string) || 'Uncategorized';
    byCategory[category] = (byCategory[category] ?? 0) + 1;
  }

  const result = await sendEmailSafe(
    reportDigestEmail(inbox, unreadCount, byCategory),
    { template: 'report_digest', category: 'transactional' }
  );

  logInfo('report_digest_sent', 'email', {
    unreadCount, delivered: !!result, statusCode: 200, durationMs: elapsed(),
  });

  return successResponse(res, { unreadCount, sent: !!result });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleCors(req, res)) return;

  const elapsed = startTimer();

  // The cron runs before verifyAuth: a scheduled invocation carries
  // CRON_SECRET, not a Firebase token.
  if (req.method === 'GET') {
    try {
      return await handleReportDigest(req, res, elapsed);
    } catch (err: any) {
      logError('report_digest_error', 'email', { statusCode: 500, durationMs: elapsed(), errorMessage: err?.message });
      return errorResponse(res, 'Digest failed', 500);
    }
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  // Requiring a verified session — anonymous included, which is what the
  // public contact form uses via getTokenOrAnonymous() — is what stops this
  // endpoint being an open mail relay.
  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const action = asString(req.body?.action);

  try {
    switch (action) {
      case 'contact':
        return await handleContact(req, res, uid, elapsed);
      case 'broadcast':
        return await handleBroadcast(req, res, uid, elapsed);
      default:
        return errorResponse(res, `Unknown action: "${action}". Valid actions: contact, broadcast`, 400);
    }
  } catch (err: any) {
    logError('email_action_error', 'email', {
      uid, action, statusCode: 500, durationMs: elapsed(), errorMessage: err?.message,
    });
    return errorResponse(res, 'Notification request failed', 500);
  }
}
