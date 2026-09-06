import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

const sendBatchSafe = vi.hoisted(() => vi.fn(async (messages: unknown[]) => messages.length));
vi.mock('../../lib/email', () => ({
  sendBatchSafe,
  BATCH_MAX: 100,
}));

import { __testUtils as fb, db } from '../helpers/mockFirebaseAdmin';
import {
  enqueueEmails,
  drainQueue,
  pendingCount,
  DAILY_SEND_CAP,
  MAIL_QUEUE,
} from '../../lib/mail-queue';

const message = (n: number) => ({
  to: `user${n}@example.com`,
  subject: `Subject ${n}`,
  html: `<p>Body ${n}</p>`,
  text: `Body ${n}`,
});

const messages = (count: number) => Array.from({ length: count }, (_, i) => message(i));

/**
 * Seeds pending rows directly. Ids carry a sortable numeric prefix, matching
 * how enqueueEmails() mints them — FIFO comes from the document id, not from
 * an orderBy, so that a drain needs no composite index.
 */
const seedPending = (count: number, batchId = 'batch-1', startAt = 0) => {
  for (let i = 0; i < count; i++) {
    fb.seedDoc(MAIL_QUEUE, `${String(startAt + i).padStart(6, '0')}-${batchId}`, {
      ...message(startAt + i),
      batchId,
      template: 'broadcast',
      status: 'pending',
      attempts: 0,
      createdAt: startAt + i,
    });
  }
};

beforeEach(() => {
  fb.reset();
  vi.clearAllMocks();
  sendBatchSafe.mockImplementation(async (msgs: unknown[]) => (msgs as unknown[]).length);
});

describe('lib/mail-queue — enqueue', () => {
  it('writes one pending row per message', async () => {
    const queued = await enqueueEmails(messages(3), { template: 'broadcast', batchId: 'b1' });

    expect(queued).toBe(3);
    expect(await pendingCount()).toBe(3);
  });

  it('sends nothing at enqueue time — that is the whole point', async () => {
    await enqueueEmails(messages(3), { template: 'broadcast', batchId: 'b1' });
    expect(sendBatchSafe).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty list', async () => {
    expect(await enqueueEmails([], { template: 'broadcast', batchId: 'b1' })).toBe(0);
    expect(await pendingCount()).toBe(0);
  });

  it('writes past Firestore\'s 500-op batch limit without throwing', async () => {
    // A commit of more than 500 operations is rejected outright rather than
    // truncated, so the chunking here is load-bearing.
    const queued = await enqueueEmails(messages(1200), { template: 'broadcast', batchId: 'big' });
    expect(queued).toBe(1200);
    expect(await pendingCount()).toBe(1200);
  });
});

describe('lib/mail-queue — draining', () => {
  it('releases no more than the daily cap', async () => {
    seedPending(DAILY_SEND_CAP + 40);

    const result = await drainQueue();

    expect(result.sent).toBe(DAILY_SEND_CAP);
    expect(sendBatchSafe.mock.calls[0][0]).toHaveLength(DAILY_SEND_CAP);
    expect(await pendingCount()).toBe(40);
  });

  it('leaves the rest pending for the following day', async () => {
    seedPending(DAILY_SEND_CAP + 10);
    await drainQueue();
    expect(await pendingCount()).toBe(10);
  });

  it('will not send twice in one day, however often it is invoked', async () => {
    // Vercel cron delivery is best-effort and can fire the same run twice;
    // going over the provider cap is the exact failure this module exists to
    // prevent, so the day's allowance lives in a counter rather than being
    // inferred from the queue.
    seedPending(DAILY_SEND_CAP + 40);

    const first = await drainQueue();
    const second = await drainQueue();

    expect(first.sent).toBe(DAILY_SEND_CAP);
    expect(second.sent).toBe(0);
    expect(second.attempted).toBe(0);
    expect(await pendingCount()).toBe(40);
  });

  it('tops up to the cap when an earlier run sent only part of it', async () => {
    await db.collection('cronRuns').doc('mail_queue').set({
      date: new Date().toISOString().slice(0, 10),
      sent: DAILY_SEND_CAP - 5,
    });
    seedPending(20);

    const result = await drainQueue();

    expect(result.sent).toBe(5);
    expect(await pendingCount()).toBe(15);
  });

  it('sends oldest first, so one big broadcast cannot starve a later one', async () => {
    seedPending(2, 'older', 0);
    seedPending(2, 'newer', 100);

    await drainQueue();

    // Ordering is by document id, which is minted with a millisecond prefix
    // at enqueue time — an orderBy('createdAt') beside the status filter
    // would need a composite index this project does not deploy.
    const sent = sendBatchSafe.mock.calls[0][0] as Array<{ to: string }>;
    expect(sent[0].to).toBe('user0@example.com');
    expect(sent[1].to).toBe('user1@example.com');
  });

  it('marks released rows as sent', async () => {
    seedPending(2);
    await drainQueue();

    const rows = Object.values(fb.dumpCollection(MAIL_QUEUE)) as Array<{ status: string; attempts: number }>;
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });

  it('marks the tail failed when the provider accepts only some', async () => {
    // sendBatchSafe reports a count, not which messages succeeded, so a
    // partial acceptance has to be attributed to the slice. Marking the
    // remainder failed keeps it visible in the admin panel; marking it sent
    // would lose the mail silently.
    seedPending(5);
    sendBatchSafe.mockResolvedValueOnce(3);

    const result = await drainQueue();

    expect(result.sent).toBe(3);
    const rows = Object.values(fb.dumpCollection(MAIL_QUEUE)) as Array<{ status: string; lastError?: string }>;
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'failed')).toHaveLength(2);
    expect(rows.find((r) => r.status === 'failed')?.lastError).toBeTruthy();
  });

  it('does not count failures against the daily allowance', async () => {
    seedPending(5);
    sendBatchSafe.mockResolvedValueOnce(3);
    await drainQueue();

    const counter = fb.getDoc('cronRuns', 'mail_queue');
    expect(counter?.sent).toBe(3);
  });

  it('is a no-op on an empty queue', async () => {
    const result = await drainQueue();
    expect(result).toMatchObject({ attempted: 0, sent: 0, pending: 0 });
    expect(sendBatchSafe).not.toHaveBeenCalled();
  });

  it('skips the per-recipient opt-out check, which was applied at enqueue time', async () => {
    seedPending(2);
    await drainQueue();
    expect(sendBatchSafe.mock.calls[0][1]).toMatchObject({ prefsChecked: true });
  });
});
