import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockReqRes, bearer } from '../helpers/httpMocks';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));
vi.mock('../../lib/email', () => import('../helpers/mockEmail'));

// Push is mocked at the module boundary (the ask-ai provider pattern) —
// isPushSubscribed keeps its real semantics so the broadcast filter is
// genuinely exercised, only the FCM call itself is stubbed.
const pushMock = vi.hoisted(() => ({ sendPushToTokens: vi.fn(async () => 1) }));
vi.mock('../../lib/push', async () => {
  const actual = await vi.importActual<typeof import('../../lib/push')>('../../lib/push');
  return { ...actual, sendPushToTokens: pushMock.sendPushToTokens };
});

import { __testUtils } from '../helpers/mockFirebaseAdmin';
import { __testUtils as emailUtils } from '../helpers/mockEmail';
import handler from '../../api/email';

const TOKEN_ALICE = 'token-alice';
const TOKEN_ADMIN = 'token-admin';

const CONTACT_BODY = {
  action: 'contact',
  name: 'Ana Silva',
  email: 'ana@test.local',
  subject: 'support',
  message: 'My streak reset unexpectedly.',
};

beforeEach(() => {
  __testUtils.reset();
  emailUtils.reset();
  pushMock.sendPushToTokens.mockClear();

  __testUtils.setValidToken(TOKEN_ALICE, { uid: 'alice' });
  __testUtils.setValidToken(TOKEN_ADMIN, { uid: 'admin1' });
  __testUtils.seedDoc('users', 'alice', { email: 'alice@test.local', subscriptionTier: 'explorer' });
  __testUtils.seedDoc('users', 'admin1', { email: 'admin@test.local', subscriptionTier: 'admin' });

  process.env.CONTACT_INBOX = 'inbox@test.local';
});

function post(token: string, body: any) {
  return createMockReqRes({ method: 'POST', headers: bearer(token), body });
}

describe('POST /api/email — guards', () => {
  it.each(['PUT', 'DELETE', 'PATCH'])('rejects %s', async (method) => {
    const { req, res } = createMockReqRes({ method, headers: bearer(TOKEN_ALICE) });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('will not run the cron digest for a signed-in user — GET needs CRON_SECRET', async () => {
    const { req, res } = createMockReqRes({ method: 'GET', headers: bearer(TOKEN_ALICE) });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(emailUtils.getSent()).toHaveLength(0);
  });

  it('requires a verified session — this is what stops it being an open relay', async () => {
    const { req, res } = createMockReqRes({ method: 'POST', body: CONTACT_BODY });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(emailUtils.getSent()).toHaveLength(0);
  });

  it('rejects an unknown action', async () => {
    const { req, res } = post(TOKEN_ALICE, { action: 'nope' });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/email — contact', () => {
  it('sends to CONTACT_INBOX and records the submission', async () => {
    const { req, res } = post(TOKEN_ALICE, CONTACT_BODY);
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const sent = emailUtils.sentFor('contact');
    expect(sent).toHaveLength(1);
    expect(sent[0].message.to).toBe('inbox@test.local');
    // Reply-to is the submitter so a reply reaches them, not the app.
    expect(sent[0].message.replyTo).toBe('ana@test.local');

    const stored = Object.values(__testUtils.dumpCollection('contactSubmissions')) as any[];
    expect(stored).toHaveLength(1);
    expect(stored[0].message).toBe('My streak reset unexpectedly.');
  });

  it.each([
    ['name', { name: '' }],
    ['email', { email: '' }],
    ['message', { message: '' }],
  ])('requires %s', async (_field, override) => {
    const { req, res } = post(TOKEN_ALICE, { ...CONTACT_BODY, ...override });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(emailUtils.getSent()).toHaveLength(0);
  });

  it('rejects a subject outside the allowed set', async () => {
    const { req, res } = post(TOKEN_ALICE, { ...CONTACT_BODY, subject: 'anything' });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed email address', async () => {
    const { req, res } = post(TOKEN_ALICE, { ...CONTACT_BODY, email: 'not-an-address' });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects an over-long message', async () => {
    const { req, res } = post(TOKEN_ALICE, { ...CONTACT_BODY, message: 'x'.repeat(5001) });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rate-limits after 3 submissions in the window', async () => {
    for (let i = 0; i < 3; i++) {
      const { req, res } = post(TOKEN_ALICE, CONTACT_BODY);
      await handler(req, res);
      expect(res.statusCode).toBe(200);
    }

    const { req, res } = post(TOKEN_ALICE, CONTACT_BODY);
    await handler(req, res);
    expect(res.statusCode).toBe(429);
    expect(emailUtils.sentFor('contact')).toHaveLength(3);
  });

  it('still reports success when the provider fails, because the message was stored', async () => {
    emailUtils.failNextSend();
    const { req, res } = post(TOKEN_ALICE, CONTACT_BODY);
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(Object.values(__testUtils.dumpCollection('contactSubmissions'))).toHaveLength(1);
  });

  it('fails without leaking internals when CONTACT_INBOX is unset', async () => {
    delete process.env.CONTACT_INBOX;
    const { req, res } = post(TOKEN_ALICE, CONTACT_BODY);
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Failed to send message');
  });
});

describe('POST /api/email — broadcast', () => {
  const BROADCAST = {
    action: 'broadcast',
    subject: 'New grammar drills',
    body: 'We just added 200 new exercises.',
    channels: { email: true, push: false },
  };

  it('refuses a non-admin caller', async () => {
    const { req, res } = post(TOKEN_ALICE, { ...BROADCAST, mode: 'all', confirm: 'ALL' });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(emailUtils.getSent()).toHaveLength(0);
  });

  it('requires the typed confirmation before reaching every user', async () => {
    const { req, res } = post(TOKEN_ADMIN, { ...BROADCAST, mode: 'all' });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(emailUtils.getSent()).toHaveLength(0);
  });

  it('broadcasts to all users once confirmed', async () => {
    const { req, res } = post(TOKEN_ADMIN, { ...BROADCAST, mode: 'all', confirm: 'ALL' });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.total).toBe(2);
    // Queued, not sent — the cron releases these at the daily cap.
    expect(res.body.data.emailQueued).toBe(2);
    expect(res.body.data.queueDepth).toBe(2);
    expect(emailUtils.getSent()).toHaveLength(0);
  });

  it('skips users who opted out of announcements', async () => {
    __testUtils.seedDoc('users', 'alice', {
      email: 'alice@test.local',
      subscriptionTier: 'explorer',
      notificationPrefs: { announcements: { email: false, push: false } },
    });

    const { req, res } = post(TOKEN_ADMIN, { ...BROADCAST, mode: 'all', confirm: 'ALL' });
    await handler(req, res);

    // The opt-out is applied at enqueue time, from the user documents already
    // in hand — the drain has no per-recipient preference check of its own.
    expect(res.body.data.emailQueued).toBe(1);
    expect(res.body.data.emailSkipped).toBe(1);
    const queued = Object.values(__testUtils.dumpCollection('mailQueue')) as Array<{ to: string }>;
    expect(queued.every((row) => row.to !== 'alice@test.local')).toBe(true);
  });

  it('targets a single user', async () => {
    const { req, res } = post(TOKEN_ADMIN, { ...BROADCAST, mode: 'user', uid: 'alice' });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.total).toBe(1);
    const queued = Object.values(__testUtils.dumpCollection('mailQueue')) as Array<{ to: string }>;
    expect(queued[0].to).toBe('alice@test.local');
  });

  it('404s for a target user that does not exist', async () => {
    const { req, res } = post(TOKEN_ADMIN, { ...BROADCAST, mode: 'user', uid: 'ghost' });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('targets a subscription tier', async () => {
    __testUtils.seedDoc('users', 'carol', { email: 'carol@test.local', subscriptionTier: 'voyager' });

    const { req, res } = post(TOKEN_ADMIN, { ...BROADCAST, mode: 'tier', tier: 'voyager' });
    await handler(req, res);

    expect(res.body.data.total).toBe(1);
    const queued = Object.values(__testUtils.dumpCollection('mailQueue')) as Array<{ to: string }>;
    expect(queued[0].to).toBe('carol@test.local');
  });

  it('requires a subject, a body and at least one channel', async () => {
    for (const override of [{ subject: '' }, { body: '' }, { channels: { email: false, push: false } }]) {
      const { req, res } = post(TOKEN_ADMIN, { ...BROADCAST, mode: 'user', uid: 'alice', ...override });
      await handler(req, res);
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects an unknown mode', async () => {
    const { req, res } = post(TOKEN_ADMIN, { ...BROADCAST, mode: 'everyone' });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('pushes only to users opted in to push who have a token', async () => {
    __testUtils.seedDoc('users', 'alice', {
      email: 'alice@test.local',
      subscriptionTier: 'explorer',
      fcmTokens: ['token-1'],
      notificationPrefs: { announcements: { email: true, push: true } },
    });

    const { req, res } = post(TOKEN_ADMIN, {
      ...BROADCAST, mode: 'all', confirm: 'ALL', channels: { email: false, push: true },
    });
    await handler(req, res);

    expect(res.body.data.pushSent).toBe(1);
    // admin1 has neither a token nor a push opt-in.
    expect(res.body.data.pushSkipped).toBe(1);
    expect(pushMock.sendPushToTokens).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/email — nightly report digest', () => {
  const CRON_SECRET = 'test-cron-secret';

  /** Seeds a report under appConfig/config/reports. */
  const seedReport = (id: string, category: string, read = false) =>
    __testUtils.seedDoc('appConfig/config/reports', id, {
      category, read, message: 'something broke', createdAt: '2026-09-01T10:00:00.000Z',
    });

  const cronRequest = (auth?: string) =>
    createMockReqRes({ method: 'GET', headers: auth ? { authorization: auth } : {} });

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
  });

  it('refuses a request without the cron secret', async () => {
    seedReport('r1', 'Bug / Error');
    const { req, res } = cronRequest();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(emailUtils.getSent()).toHaveLength(0);
  });

  it('refuses a wrong secret', async () => {
    const { req, res } = cronRequest('Bearer nope');
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('refuses when CRON_SECRET is not configured at all', async () => {
    delete process.env.CRON_SECRET;
    const { req, res } = cronRequest('Bearer anything');
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('sends nothing when there are no unread reports', async () => {
    seedReport('r1', 'Bug / Error', true); // already read
    const { req, res } = cronRequest(`Bearer ${CRON_SECRET}`);
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.digest).toEqual({ unreadCount: 0, sent: false });
    expect(emailUtils.getSent()).toHaveLength(0);
  });

  it('counts only unread reports and groups them by category', async () => {
    seedReport('r1', 'Bug / Error');
    seedReport('r2', 'Bug / Error');
    seedReport('r3', 'Wrong translation');
    seedReport('r4', 'Other', true); // read — must not be counted

    const { req, res } = cronRequest(`Bearer ${CRON_SECRET}`);
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.digest.unreadCount).toBe(3);

    const sent = emailUtils.sentFor('report_digest');
    expect(sent).toHaveLength(1);
    expect(sent[0].message.to).toBe('inbox@test.local');
    expect(sent[0].message.subject).toContain('3 unread reports');
    expect(sent[0].message.text).toContain('Bug / Error: 2');
    expect(sent[0].message.text).toContain('Wrong translation: 1');
  });

  it('uses the singular for exactly one report', async () => {
    seedReport('r1', 'Other');
    const { req, res } = cronRequest(`Bearer ${CRON_SECRET}`);
    await handler(req, res);
    expect(emailUtils.sentFor('report_digest')[0].message.subject).toContain('1 unread report —');
  });

  it('does not send twice on the same day — cron delivery can duplicate a run', async () => {
    seedReport('r1', 'Bug / Error');

    const first = cronRequest(`Bearer ${CRON_SECRET}`);
    await handler(first.req, first.res);
    expect(emailUtils.sentFor('report_digest')).toHaveLength(1);

    const second = cronRequest(`Bearer ${CRON_SECRET}`);
    await handler(second.req, second.res);

    expect(second.res.statusCode).toBe(200);
    expect(second.res.body.data.digest.skipped).toBe('already ran today');
    expect(emailUtils.sentFor('report_digest')).toHaveLength(1);
  });
});
