import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils, sendEachForMulticast } from '../helpers/mockFirebaseAdmin';
import { sendPushSafe, sendPushToTokens, isPushSubscribed, isPushEnabled } from '../../lib/push';

const MSG = { title: 'New drills', body: '200 new exercises' };
const CTX = { template: 'broadcast', category: 'announcements' as const };

beforeEach(() => {
  __testUtils.reset();
  delete process.env.PUSH_ENABLED;
});

afterEach(() => {
  delete process.env.PUSH_ENABLED;
});

describe('isPushEnabled', () => {
  it('is on by default and off only when explicitly disabled', () => {
    expect(isPushEnabled()).toBe(true);
    process.env.PUSH_ENABLED = 'false';
    expect(isPushEnabled()).toBe(false);
  });
});

describe('isPushSubscribed', () => {
  it('always allows transactional', () => {
    expect(isPushSubscribed({}, 'transactional')).toBe(true);
  });

  it('defaults optional categories to opted out', () => {
    expect(isPushSubscribed({}, 'announcements')).toBe(false);
    expect(isPushSubscribed(undefined, 'reminders')).toBe(false);
  });

  it('honours an explicit opt-in', () => {
    expect(
      isPushSubscribed({ notificationPrefs: { announcements: { push: true } } }, 'announcements')
    ).toBe(true);
  });
});

describe('sendPushSafe', () => {
  it('does nothing when push is disabled', async () => {
    process.env.PUSH_ENABLED = 'false';
    __testUtils.seedDoc('users', 'alice', { fcmTokens: ['t1'] });
    await expect(sendPushSafe('alice', MSG, CTX)).resolves.toBe(0);
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('returns 0 for a user that does not exist', async () => {
    await expect(sendPushSafe('ghost', MSG, CTX)).resolves.toBe(0);
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('respects an opt-out even when tokens are registered', async () => {
    __testUtils.seedDoc('users', 'alice', {
      fcmTokens: ['t1'],
      notificationPrefs: { announcements: { push: false } },
    });
    await expect(sendPushSafe('alice', MSG, CTX)).resolves.toBe(0);
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('returns 0 when the user opted in but has no device registered', async () => {
    __testUtils.seedDoc('users', 'alice', {
      notificationPrefs: { announcements: { push: true } },
    });
    await expect(sendPushSafe('alice', MSG, CTX)).resolves.toBe(0);
  });

  it('sends to every registered device for an opted-in user', async () => {
    __testUtils.seedDoc('users', 'alice', {
      fcmTokens: ['t1', 't2'],
      notificationPrefs: { announcements: { push: true } },
    });

    await expect(sendPushSafe('alice', MSG, CTX)).resolves.toBe(2);
    const payload = (sendEachForMulticast as any).mock.calls[0][0];
    expect(payload.tokens).toEqual(['t1', 't2']);
    expect(payload.notification).toEqual({ title: MSG.title, body: MSG.body });
  });

  it('sends transactional push without an opt-in', async () => {
    __testUtils.seedDoc('users', 'alice', { fcmTokens: ['t1'] });
    await expect(
      sendPushSafe('alice', MSG, { template: 'x', category: 'transactional' })
    ).resolves.toBe(1);
  });
});

describe('sendPushToTokens', () => {
  it('carries the click-through link in both the data and webpush payloads', async () => {
    await sendPushToTokens('alice', ['t1'], { ...MSG, link: '/dashboard/grammar' }, CTX);
    const payload = (sendEachForMulticast as any).mock.calls[0][0];
    expect(payload.data.link).toBe('/dashboard/grammar');
    expect(payload.webpush.fcmOptions.link).toBe('/dashboard/grammar');
  });

  it('is a no-op for an empty token list', async () => {
    await expect(sendPushToTokens('alice', [], MSG, CTX)).resolves.toBe(0);
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('prunes tokens FCM reports as dead, keeping the live ones', async () => {
    __testUtils.seedDoc('users', 'alice', { fcmTokens: ['live', 'dead', 'other'] });
    (sendEachForMulticast as any).mockResolvedValueOnce({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
      ],
    });

    await expect(sendPushToTokens('alice', ['live', 'dead'], MSG, CTX)).resolves.toBe(1);
    expect(__testUtils.getDoc('users', 'alice')?.fcmTokens).toEqual(['live', 'other']);
  });

  it('keeps a token that failed for a transient reason', async () => {
    __testUtils.seedDoc('users', 'alice', { fcmTokens: ['t1'] });
    (sendEachForMulticast as any).mockResolvedValueOnce({
      successCount: 0,
      failureCount: 1,
      responses: [{ success: false, error: { code: 'messaging/internal-error' } }],
    });

    await sendPushToTokens('alice', ['t1'], MSG, CTX);
    expect(__testUtils.getDoc('users', 'alice')?.fcmTokens).toEqual(['t1']);
  });

  it('never throws when FCM itself fails', async () => {
    (sendEachForMulticast as any).mockRejectedValueOnce(new Error('FCM unavailable'));
    await expect(sendPushToTokens('alice', ['t1'], MSG, CTX)).resolves.toBe(0);
  });
});
