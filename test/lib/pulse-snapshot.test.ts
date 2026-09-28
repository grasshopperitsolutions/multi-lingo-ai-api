import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));
vi.mock('../../lib/stripe', () => import('../helpers/mockStripe'));

import { __testUtils, auth } from '../helpers/mockFirebaseAdmin';
import { __testUtils as stripeUtils, stripe } from '../helpers/mockStripe';
import { writeDailySnapshot } from '../../lib/pulse-snapshot';

// The cron runs at 06:00 for the day that just ended.
const NOW = new Date('2026-09-28T06:00:00Z');
const DAY = '2026-09-27';
const snapshot = () => __testUtils.getDoc('appConfig/pulse/days', DAY) as any;

beforeEach(() => {
  __testUtils.reset();
  stripeUtils.reset();

  __testUtils.seedDoc('users', 'a', {
    subscriptionTier: 'maestro', subscriptionStatus: 'active', cancelAtPeriodEnd: true,
    onboardingCompleted: true, createdAt: new Date('2026-09-27T09:00:00Z'), lastStreakDate: DAY,
  });
  __testUtils.seedDoc('users', 'b', { subscriptionStatus: 'past_due', createdAt: new Date('2026-01-01T00:00:00Z') });
  __testUtils.seedDoc('users', 'c', { subscriptionTier: 'voyager', subscriptionStatus: 'trialing' });

  __testUtils.seedAuthUser('a', { providerData: [{}], metadata: { lastRefreshTime: '2026-09-28T05:00:00Z' } });
  __testUtils.seedAuthUser('b', { providerData: [{}], metadata: { lastRefreshTime: '2026-09-10T05:00:00Z' } });
  __testUtils.seedAuthUser('guest', { providerData: [], metadata: { lastRefreshTime: '2026-09-28T05:00:00Z' } });

  __testUtils.seedDoc('stories', 's1', { createdAt: new Date('2026-09-27T20:00:00Z') });
  __testUtils.seedDoc('stories', 's2', { createdAt: new Date('2026-09-26T20:00:00Z') });
  __testUtils.seedDoc('stories/s1/content', 'pt-PT', {});
  __testUtils.seedDoc('stories/s1/content', 'en-US', {});
  __testUtils.seedDoc('historyFacts/h1/content', 'en-US', {});
  // An exam's content is per dialect and adapted, never translated.
  __testUtils.seedDoc('examExercises/e1/content', 'pt-PT', {});

  __testUtils.seedDoc('wordPool/w1/translations', 'pt-PT', { source: 'ai', locale: 'pt-PT' });
  __testUtils.seedDoc('wordPool/w2/translations', 'pt-PT', { source: 'user', locale: 'pt-PT' });
  __testUtils.seedDoc('wordPool/w2/translations', 'es-ES', { source: 'ai', locale: 'es-ES' });

  __testUtils.seedDoc('users/a/personalPhrases', 'p1', { text: 'never read' });
  __testUtils.seedDoc('users/a/personalPhrases', 'p2', { text: 'never read' });
  __testUtils.seedDoc('users/b/personalPhrases', 'p3', { text: 'never read' });
  __testUtils.seedDoc('users/a/personalNotes', 'board', { text: 'never read' });

  stripeUtils.seedSubscription('sub_a', {
    status: 'active',
    items: { data: [{ quantity: 1, price: { id: 'price_maestro_yearly', unit_amount: 12000, currency: 'eur', recurring: { interval: 'year' } } }] },
  });
  stripeUtils.seedSubscription('sub_b', {
    status: 'active',
    items: { data: [{ quantity: 1, price: { id: 'price_voyager_monthly', unit_amount: 499, currency: 'eur', recurring: { interval: 'month' } } }] },
  });
  stripeUtils.seedSubscription('sub_c', { status: 'trialing', items: { data: [] } });
  stripeUtils.seedSubscription('sub_d', { status: 'canceled', items: { data: [] } });
});

describe('writeDailySnapshot', () => {
  it('writes the recount for the day that just ended', async () => {
    const result = await writeDailySnapshot(NOW);

    expect(result).toEqual({ day: DAY, ok: true, failedSections: [] });
    const s = snapshot();
    expect(s.users).toEqual({
      total: 3,
      byTier: { maestro: 1, explorer: 1, voyager: 1 },
      onboarded: 1,
      signUps: 1,
      subscriptions: { active: 2, pastDue: 1, cancelled: 0, cancelScheduled: 1 },
      streakActive: 1,
    });
    // Guests have no provider and are not accounts.
    expect(s.lastSeen).toEqual({ within1Day: 1, within7Days: 1, within30Days: 2, accounts: 2 });
    expect(s.pools.stories).toEqual({ total: 2, createdOnDay: 1 });
    expect(s.pools.wordPool).toEqual({ total: 0, createdOnDay: 0 });
    expect(s.personalSpace.personalPhrases).toEqual({ people: 2, items: 3 });
    expect(s.personalSpace.personalNotes).toEqual({ people: 1, items: 1 });
    expect(s.wordTranslations).toEqual({ bySource: { ai: 2, user: 1 }, byLocale: { 'pt-PT': 2, 'es-ES': 1 } });
    expect(s.contentTranslations).toEqual({ stories: { 'pt-PT': 1, 'en-US': 1 }, historyFacts: { 'en-US': 1 } });
    expect(s.revenue).toEqual({
      mrr: { eur: 1000 + 499 },
      byTier: {
        maestro: { subscriptions: 1, mrr: { eur: 1000 } },
        voyager: { subscriptions: 1, mrr: { eur: 499 } },
      },
      active: 2,
      trialing: 1,
    });
  });

  it('holds counts only, never what anyone wrote', async () => {
    await writeDailySnapshot(NOW);
    expect(JSON.stringify(snapshot())).not.toContain('never read');
  });

  it('keeps every other section when one source fails, and names the one that did', async () => {
    stripe.subscriptions.list.mockImplementationOnce(() => {
      throw new Error('stripe is down');
    });
    auth.listUsers.mockRejectedValueOnce(new Error('auth is down'));

    const result = await writeDailySnapshot(NOW);

    expect(result.ok).toBe(true);
    expect(result.failedSections.sort()).toEqual(['lastSeen', 'revenue']);
    expect(snapshot().revenue).toBeNull();
    expect(snapshot().errors).toEqual({ lastSeen: 'auth is down', revenue: 'stripe is down' });
    expect(snapshot().users.total).toBe(3);
  });

  it('replaces the day on a second run rather than adding to it', async () => {
    await writeDailySnapshot(NOW);
    await writeDailySnapshot(NOW);
    expect(snapshot().pools.stories.total).toBe(2);
  });
});
