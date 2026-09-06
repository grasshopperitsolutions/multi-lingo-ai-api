/**
 * A Firestore-backed outbox for bulk mail, drained on a daily cap.
 *
 * Resend's free tier allows 100 emails a day. Transactional mail — welcome,
 * billing, account deletion — must never wait for a queue, so the cap here is
 * deliberately below 100: the remainder is headroom those sends draw on
 * without coordination.
 *
 * Only broadcasts queue. A 200-recipient announcement takes three days to go
 * out, which is the intended trade: an announcement is not time-critical, and
 * the alternative is silently dropping two thirds of it. Before this existed,
 * an over-cap broadcast produced provider rejections that sendBatchSafe
 * recorded as ordinary "skips", so the mail simply never arrived and nothing
 * said so.
 *
 * Documents are written only by the Admin SDK and read back only by an admin
 * (see lib/collection-policies.ts), so nothing here is client-reachable.
 */

import { db, FieldValue } from './firebase-admin';
import { sendBatchSafe, type EmailMessage } from './email';
import { logInfo, logWarn } from './logger';

/** Collection holding pending and recently-sent messages. */
export const MAIL_QUEUE = 'mailQueue';

/**
 * Messages released per day. Resend's free tier is 100/day; the 25 held back
 * is headroom for transactional mail, which bypasses the queue entirely.
 */
export const DAILY_SEND_CAP = 75;

export type QueuedStatus = 'pending' | 'sent' | 'failed';

export interface QueuedMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Groups the rows produced by one broadcast, for the admin panel. */
  batchId: string;
  template: string;
  status: QueuedStatus;
  attempts: number;
  createdAt: FirebaseFirestore.FieldValue;
  sentAt?: FirebaseFirestore.FieldValue;
  lastError?: string;
}

/** Today in UTC, as the YYYY-MM-DD key the daily counter is stamped with. */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Adds messages to the outbox. Returns the batch id so the caller can report
 * queue position back to the admin.
 *
 * Writes in chunks of 500 because that is Firestore's hard limit on a batched
 * write — exceeding it throws rather than truncating.
 */
export async function enqueueEmails(
  messages: EmailMessage[],
  context: { template: string; batchId: string }
): Promise<number> {
  if (messages.length === 0) return 0;

  const collection = db.collection(MAIL_QUEUE);
  const FIRESTORE_BATCH_LIMIT = 500;

  for (let i = 0; i < messages.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = messages.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const writer = db.batch();

    for (const message of chunk) {
      // The document id carries the enqueue time, so Firestore's default
      // __name__ ordering is already chronological. See drainQueue() for why
      // that matters. Millisecond timestamps are a fixed 13 digits until the
      // year 2286, so lexicographic and numeric order agree.
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      writer.set(collection.doc(id), {
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        batchId: context.batchId,
        template: context.template,
        status: 'pending' as QueuedStatus,
        attempts: 0,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    await writer.commit();
  }

  logInfo('mail_queued', 'mail-queue', {
    queued: messages.length,
    batchId: context.batchId,
    template: context.template,
  });

  return messages.length;
}

/** Pending messages waiting to go out. Used by the admin panel's depth readout. */
export async function pendingCount(): Promise<number> {
  const snapshot = await db
    .collection(MAIL_QUEUE)
    .where('status', '==', 'pending')
    .count()
    .get();
  return snapshot.data().count;
}

/**
 * Releases up to the remaining daily allowance.
 *
 * The allowance is tracked in a counter document rather than derived from the
 * queue, so a retried or manually-triggered run cannot send a second batch on
 * the same day. That matters more than it sounds: going over the provider cap
 * is what this whole module exists to prevent.
 *
 * FIFO, so a broadcast queued first goes out first — without that, a large
 * announcement could starve a later, smaller one indefinitely.
 *
 * The ordering comes from the document id rather than an orderBy('createdAt').
 * `where(status ==) + orderBy(createdAt)` is an equality filter plus a sort on
 * a different field, which needs a **composite index** — and this repo ships
 * no firestore.indexes.json, so the first production drain would have failed
 * with "the query requires an index" and stayed broken until someone clicked
 * through the console. Ids are minted with a millisecond prefix at enqueue
 * time instead, which makes Firestore's implicit __name__ order chronological
 * and needs no index at all. Same reasoning as the contact-form rate limiter,
 * which uses a counter document for the same reason.
 */
export async function drainQueue(): Promise<{
  attempted: number;
  sent: number;
  remainingToday: number;
  pending: number;
}> {
  const today = todayKey();
  const counterRef = db.collection('cronRuns').doc('mail_queue');
  const counter = (await counterRef.get()).data();

  const sentToday = counter?.date === today ? (counter.sent as number) ?? 0 : 0;
  const allowance = DAILY_SEND_CAP - sentToday;

  if (allowance <= 0) {
    logInfo('mail_queue_cap_reached', 'mail-queue', { sentToday, cap: DAILY_SEND_CAP });
    return { attempted: 0, sent: 0, remainingToday: 0, pending: await pendingCount() };
  }

  const snapshot = await db
    .collection(MAIL_QUEUE)
    .where('status', '==', 'pending')
    .limit(allowance)
    .get();

  if (snapshot.empty) {
    return { attempted: 0, sent: 0, remainingToday: allowance, pending: 0 };
  }

  const rows = snapshot.docs;
  const messages: EmailMessage[] = rows.map((doc) => {
    const d = doc.data();
    return { to: d.to, subject: d.subject, html: d.html, text: d.text };
  });

  // sendBatchSafe never throws and returns how many the provider accepted.
  // It cannot say *which* ones, so the outcome is applied to the whole slice:
  // a partial provider failure marks the tail as failed rather than silently
  // reporting success. Erring toward "failed" is right — a failed row is
  // visible in the admin panel and can be requeued; a wrongly-sent row is not.
  const accepted = await sendBatchSafe(messages, {
    template: 'mail_queue',
    category: 'announcements',
    // The opt-out was already applied when the messages were enqueued, from
    // user documents that were in hand at the time.
    prefsChecked: true,
  });

  const writer = db.batch();
  rows.forEach((doc, index) => {
    if (index < accepted) {
      writer.update(doc.ref, {
        status: 'sent' as QueuedStatus,
        sentAt: FieldValue.serverTimestamp(),
        attempts: FieldValue.increment(1),
      });
    } else {
      writer.update(doc.ref, {
        status: 'failed' as QueuedStatus,
        attempts: FieldValue.increment(1),
        lastError: 'Provider did not accept this message',
      });
    }
  });
  await writer.commit();

  await counterRef.set(
    { date: today, sent: sentToday + accepted, ranAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  if (accepted < rows.length) {
    logWarn('mail_queue_partial', 'mail-queue', {
      attempted: rows.length,
      sent: accepted,
      failed: rows.length - accepted,
    });
  }

  const pending = await pendingCount();

  logInfo('mail_queue_drained', 'mail-queue', {
    attempted: rows.length,
    sent: accepted,
    sentToday: sentToday + accepted,
    cap: DAILY_SEND_CAP,
    pending,
  });

  return {
    attempted: rows.length,
    sent: accepted,
    remainingToday: allowance - accepted,
    pending,
  };
}
