import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils } from '../helpers/mockFirebaseAdmin';
import {
  sendEmail, sendEmailSafe, sendEmailBatch, sendBatchSafe, isEmailEnabled, BATCH_MAX,
} from '../../lib/email';

const MESSAGE = {
  to: 'user@test.local',
  subject: 'Subject line',
  html: '<p>Body</p>',
  text: 'Body',
};

function mockFetch(response: Partial<Response> & { json?: () => any; text?: () => any }) {
  const fn = vi.fn(async () => response as any);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  __testUtils.reset();
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_FROM = 'Multi Lingo AI <noreply@test.local>';
  delete process.env.EMAIL_ENABLED;
  delete process.env.EMAIL_REPLY_TO;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

describe('isEmailEnabled', () => {
  it('is false without an API key', () => {
    delete process.env.RESEND_API_KEY;
    expect(isEmailEnabled()).toBe(false);
  });

  it('is false when explicitly disabled', () => {
    process.env.EMAIL_ENABLED = 'false';
    expect(isEmailEnabled()).toBe(false);
  });

  it('is true with a key and no override', () => {
    expect(isEmailEnabled()).toBe(true);
  });
});

describe('sendEmail', () => {
  it('no-ops without calling the provider when disabled', async () => {
    process.env.EMAIL_ENABLED = 'false';
    const fetchMock = mockFetch({ ok: true, json: async () => ({ id: 'x' }) });
    await expect(sendEmail(MESSAGE)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the message to Resend and returns the id', async () => {
    const fetchMock = mockFetch({ ok: true, json: async () => ({ id: 'resend-1' }) });
    await expect(sendEmail(MESSAGE)).resolves.toEqual({ id: 'resend-1' });

    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer test-key');

    const payload = JSON.parse(init.body);
    expect(payload.to).toEqual(['user@test.local']);
    expect(payload.subject).toBe('Subject line');
    // Both parts are always sent — text/plain matters for deliverability.
    expect(payload.html).toBe('<p>Body</p>');
    expect(payload.text).toBe('Body');
  });

  it('throws without leaking the provider body when the API rejects', async () => {
    mockFetch({ ok: false, status: 422, text: async () => 'invalid to address' });
    await expect(sendEmail(MESSAGE)).rejects.toThrow(/422/);
  });

  it('requires EMAIL_FROM', async () => {
    delete process.env.EMAIL_FROM;
    mockFetch({ ok: true, json: async () => ({ id: 'x' }) });
    await expect(sendEmail(MESSAGE)).rejects.toThrow(/EMAIL_FROM/);
  });
});

describe('sendEmailSafe', () => {
  it('never throws when the provider fails', async () => {
    mockFetch({ ok: false, status: 500, text: async () => 'boom' });
    await expect(
      sendEmailSafe(MESSAGE, { template: 'welcome', category: 'transactional' })
    ).resolves.toBeNull();
  });

  it('sends transactional mail without consulting preferences', async () => {
    // No user document exists at all — a transactional send must still go.
    const fetchMock = mockFetch({ ok: true, json: async () => ({ id: 'r1' }) });
    await expect(
      sendEmailSafe(MESSAGE, { template: 'payment_failed', uid: 'ghost', category: 'transactional' })
    ).resolves.toEqual({ id: 'r1' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('drops an optional send for a user who opted out', async () => {
    __testUtils.seedDoc('users', 'alice', {
      notificationPrefs: { announcements: { email: false, push: false } },
    });
    const fetchMock = mockFetch({ ok: true, json: async () => ({ id: 'r1' }) });

    await expect(
      sendEmailSafe(MESSAGE, { template: 'broadcast', uid: 'alice', category: 'announcements' })
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an optional message to a user who is still opted in', async () => {
    __testUtils.seedDoc('users', 'bob', { email: 'bob@test.local' });
    const fetchMock = mockFetch({ ok: true, json: async () => ({ id: 'r2' }) });

    await expect(
      sendEmailSafe(MESSAGE, { template: 'broadcast', uid: 'bob', category: 'announcements' })
    ).resolves.toEqual({ id: 'r2' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('skips the preference read when the caller already checked', async () => {
    __testUtils.seedDoc('users', 'alice', {
      notificationPrefs: { announcements: { email: false, push: false } },
    });
    const fetchMock = mockFetch({ ok: true, json: async () => ({ id: 'r3' }) });

    // prefsChecked short-circuits the lookup — the broadcast path filters
    // from documents it already holds.
    await expect(
      sendEmailSafe(MESSAGE, {
        template: 'broadcast', uid: 'alice', category: 'announcements', prefsChecked: true,
      })
    ).resolves.toEqual({ id: 'r3' });
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('sendEmailBatch', () => {
  const many = (count: number): typeof MESSAGE[] =>
    Array.from({ length: count }, (_, i) => ({ ...MESSAGE, to: `user${i}@test.local` }));

  it('posts a bare JSON array to the batch endpoint', async () => {
    const fetchMock = mockFetch({ ok: true, json: async () => ({ data: [{ id: 'a' }, { id: 'b' }] }) });
    await expect(sendEmailBatch(many(2))).resolves.toBe(2);

    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe('https://api.resend.com/emails/batch');

    // The batch endpoint takes an array, not an object wrapper.
    const payload = JSON.parse(init.body);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
    expect(payload[0].to).toEqual(['user0@test.local']);
    expect(payload[0].from).toBe('Multi Lingo AI <noreply@test.local>');
  });

  it('refuses a batch larger than the provider limit', async () => {
    mockFetch({ ok: true, json: async () => ({ data: [] }) });
    await expect(sendEmailBatch(many(BATCH_MAX + 1))).rejects.toThrow(/exceeds/);
  });

  it('is a no-op for an empty list and never calls the provider', async () => {
    const fetchMock = mockFetch({ ok: true, json: async () => ({ data: [] }) });
    await expect(sendEmailBatch([])).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops when email is disabled', async () => {
    process.env.EMAIL_ENABLED = 'false';
    const fetchMock = mockFetch({ ok: true, json: async () => ({ data: [] }) });
    await expect(sendEmailBatch(many(3))).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a provider error', async () => {
    mockFetch({ ok: false, status: 429, text: async () => 'rate limited' });
    await expect(sendEmailBatch(many(3))).rejects.toThrow(/429/);
  });
});

describe('sendBatchSafe', () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ ...MESSAGE, to: `user${i}@test.local` }));

  const CTX = { template: 'broadcast', category: 'announcements' as const };

  it('splits a large audience into chunks of BATCH_MAX', async () => {
    // 250 recipients as single sends would be 250 requests — well over the
    // 10-req/s account limit. Batched it is three.
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const count = JSON.parse(init.body).length;
      return { ok: true, json: async () => ({ data: Array.from({ length: count }, () => ({ id: 'x' })) }) } as any;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendBatchSafe(many(250), CTX)).resolves.toBe(250);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const sizes = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body).length);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it('sends a single request when the audience fits in one batch', async () => {
    const fetchMock = mockFetch({ ok: true, json: async () => ({ data: many(40).map(() => ({ id: 'x' })) }) });
    await expect(sendBatchSafe(many(40), CTX)).resolves.toBe(40);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never throws, and keeps the chunks that succeeded when one fails', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const count = JSON.parse(init.body).length;
      call++;
      // Second chunk fails; the first and third must still count.
      if (call === 2) return { ok: false, status: 500, text: async () => 'boom' } as any;
      return { ok: true, json: async () => ({ data: Array.from({ length: count }, () => ({ id: 'x' })) }) } as any;
    }));

    await expect(sendBatchSafe(many(250), CTX)).resolves.toBe(150);
  });

  it('returns 0 for an empty audience without calling the provider', async () => {
    const fetchMock = mockFetch({ ok: true, json: async () => ({ data: [] }) });
    await expect(sendBatchSafe([], CTX)).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
