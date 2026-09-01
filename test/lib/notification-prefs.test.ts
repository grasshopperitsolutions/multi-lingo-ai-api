import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils } from '../helpers/mockFirebaseAdmin';
import { normalizePrefs, isSubscribed, DEFAULT_PREFS } from '../../lib/notification-prefs';

beforeEach(() => {
  __testUtils.reset();
});

describe('normalizePrefs', () => {
  it('returns the defaults for a missing prefs object', () => {
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it('defaults email on and push off', () => {
    const prefs = normalizePrefs(undefined);
    expect(prefs.announcements.email).toBe(true);
    expect(prefs.announcements.push).toBe(false);
    expect(prefs.reminders.push).toBe(false);
  });

  it('merges a partial stored object over the defaults', () => {
    const prefs = normalizePrefs({ announcements: { email: false } });
    expect(prefs.announcements.email).toBe(false);
    // Untouched keys keep their default rather than becoming undefined.
    expect(prefs.announcements.push).toBe(false);
    expect(prefs.reminders.email).toBe(true);
  });

  it('ignores non-boolean and malformed values', () => {
    const prefs = normalizePrefs({
      announcements: { email: 'nope', push: 1 },
      reminders: 'garbage',
      unknownCategory: { email: false },
    });
    expect(prefs.announcements.email).toBe(true);
    expect(prefs.announcements.push).toBe(false);
    expect(prefs.reminders.email).toBe(true);
    expect(prefs).not.toHaveProperty('unknownCategory');
  });

  it('does not mutate DEFAULT_PREFS across calls', () => {
    normalizePrefs({ announcements: { email: false } });
    expect(DEFAULT_PREFS.announcements.email).toBe(true);
  });
});

describe('isSubscribed', () => {
  it('always allows transactional, even for a user that does not exist', async () => {
    await expect(isSubscribed('nobody', 'transactional', 'email')).resolves.toBe(true);
    await expect(isSubscribed('nobody', 'transactional', 'push')).resolves.toBe(true);
  });

  it('denies optional categories when the user document is missing', async () => {
    await expect(isSubscribed('nobody', 'announcements', 'email')).resolves.toBe(false);
  });

  it('falls back to the defaults when the user has never set prefs', async () => {
    __testUtils.seedDoc('users', 'alice', { email: 'a@test.local' });
    await expect(isSubscribed('alice', 'announcements', 'email')).resolves.toBe(true);
    await expect(isSubscribed('alice', 'announcements', 'push')).resolves.toBe(false);
  });

  it('honours a stored opt-out per channel', async () => {
    __testUtils.seedDoc('users', 'alice', {
      notificationPrefs: { announcements: { email: false, push: true } },
    });
    await expect(isSubscribed('alice', 'announcements', 'email')).resolves.toBe(false);
    await expect(isSubscribed('alice', 'announcements', 'push')).resolves.toBe(true);
  });

  it('keeps categories independent', async () => {
    __testUtils.seedDoc('users', 'alice', {
      notificationPrefs: { announcements: { email: false }, reminders: { email: true } },
    });
    await expect(isSubscribed('alice', 'announcements', 'email')).resolves.toBe(false);
    await expect(isSubscribed('alice', 'reminders', 'email')).resolves.toBe(true);
  });
});
