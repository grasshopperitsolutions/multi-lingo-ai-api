import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils, db } from '../helpers/mockFirebaseAdmin';
import {
  bump,
  cleanAcquisition,
  dayKey,
  isoWeekKey,
  nestIncrements,
  planDirection,
  recordClientEvents,
  recordPlanChange,
  resolveKnownId,
  safeKey,
  __resetKnownIds,
} from '../../lib/pulse';

const NOW = new Date('2026-09-28T12:00:00Z'); // a Monday
const counters = (day = '2026-09-28') => __testUtils.getDoc('appConfig/pulse/counters', day) as any;

beforeEach(() => {
  __testUtils.reset();
  __resetKnownIds();
});

describe('keys', () => {
  it('stamps UTC days and ISO weeks', () => {
    expect(dayKey(NOW)).toBe('2026-09-28');
    expect(isoWeekKey(NOW)).toBe('2026-W40');
    expect(isoWeekKey(new Date('2026-09-27T23:59:59Z'))).toBe('2026-W39'); // Sunday
    // Early January can belong to the previous year's last week.
    expect(isoWeekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
  });

  it('makes values safe as map keys', () => {
    expect(safeKey('gemini-3.5-flash')).toBe('gemini-3_5-flash');
    expect(safeKey('a/b.c')).toBe('a_b_c');
    expect(safeKey('')).toBe('unknown');
    expect(safeKey('x'.repeat(100))).toHaveLength(64);
  });
});

describe('bump', () => {
  it('adds repeats of one path together before writing', () => {
    const nested = nestIncrements([
      [['ai', 'p', 'calls'], 1],
      [['ai', 'p', 'calls'], 2],
      [['ai', 'p', 'outputTokens'], 0],
    ]) as any;
    expect(nested.ai.p.calls).toEqual({ __increment: 3 });
    expect(nested.ai.p).not.toHaveProperty('outputTokens');
  });

  it('creates the day on first use and adds to it after', async () => {
    await bump([[['ai', 'story', 'explorer', 'calls'], 1]], NOW);
    await bump([[['ai', 'story', 'explorer', 'calls'], 1], [['ai', 'story', 'maestro', 'calls'], 5]], NOW);

    expect(counters().ai).toEqual({ story: { explorer: { calls: 2 }, maestro: { calls: 5 } } });
    expect(counters().day).toBe('2026-09-28');
  });

  it('never throws when the write fails', async () => {
    const spy = vi.spyOn(db, 'collection').mockImplementationOnce(() => {
      throw new Error('firestore down');
    });
    await expect(bump([[['x'], 1]], NOW)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('resolveKnownId', () => {
  beforeEach(() => {
    __testUtils.seedDoc('appConfig/config/prompts', 'story-generate-prompt', { template: '…' });
    __testUtils.seedDoc('appConfig/config/features', 'story_generator', {});
  });

  it('keeps ids that name a document, and nothing else', async () => {
    expect(await resolveKnownId('story-generate-prompt', 'prompts')).toBe('story-generate-prompt');
    expect(await resolveKnownId('story_generator', 'features')).toBe('story_generator');
    expect(await resolveKnownId('made-up', 'prompts')).toBe('other');
    expect(await resolveKnownId('has.dots', 'prompts')).toBe('other');
    expect(await resolveKnownId(undefined, 'prompts')).toBe('unspecified');
    expect(await resolveKnownId(42, 'features')).toBe('unspecified');
  });
});

describe('recordClientEvents', () => {
  beforeEach(() => {
    __testUtils.seedDoc('appConfig/config/features', 'story_generator', {});
    __testUtils.seedDoc('users', 'alice', {
      subscriptionTier: 'voyager',
      createdAt: new Date('2026-09-15T10:00:00Z'), // week 38
    });
  });

  it('counts a user active once a day and once a week, by sign-up cohort', async () => {
    await recordClientEvents('alice', [{ type: 'active' }], NOW);
    await recordClientEvents('alice', [{ type: 'active' }], NOW);

    expect(counters().activeUsers).toEqual({ total: 1, voyager: 1 });
    const week = __testUtils.getDoc('appConfig/pulse/weeks', '2026-W40') as any;
    expect(week.active).toBe(1);
    expect(week.cohorts).toEqual({ '2026-W38': 1 });
    expect((__testUtils.getDoc('users', 'alice') as any).pulseSeen).toEqual({ day: '2026-09-28', week: '2026-W40' });

    // The next day counts again; the week does not.
    await recordClientEvents('alice', [{ type: 'active' }], new Date('2026-09-29T08:00:00Z'));
    expect(counters('2026-09-29').activeUsers.total).toBe(1);
    expect((__testUtils.getDoc('appConfig/pulse/weeks', '2026-W40') as any).active).toBe(1);
  });

  it('counts opens, locked attempts and live seconds by tier, folding unknown pages into other', async () => {
    const counted = await recordClientEvents('alice', [
      { type: 'open', feature: 'story_generator' },
      { type: 'open', feature: 'not_a_feature' },
      { type: 'locked', feature: 'story_generator' },
      { type: 'liveSeconds', seconds: 125.4 },
      { type: 'liveSeconds', seconds: 99_999 },
      { type: 'liveSeconds', seconds: -3 },
      { type: 'nonsense' },
    ], NOW);

    expect(counted).toBe(5);
    expect(counters().pageOpens).toEqual({ story_generator: { voyager: 1 }, other: { voyager: 1 } });
    expect(counters().locked).toEqual({ story_generator: { voyager: 1 } });
    // Capped at a session's 15 minutes.
    expect(counters().liveSeconds).toEqual({ voyager: 125 + 900 });
  });

  it('counts nobody for a uid with no profile', async () => {
    await recordClientEvents('ghost', [{ type: 'active' }], NOW);
    expect(counters()).toBeUndefined();
    expect(__testUtils.getDoc('users', 'ghost')).toBeUndefined();
  });
});

describe('cleanAcquisition', () => {
  it('keeps a hostname, campaign tags and a query-free path', () => {
    expect(cleanAcquisition({
      referrerHost: 'WWW.Google.com',
      utmSource: 'instagram',
      utmMedium: 'social',
      utmCampaign: 'launch 2026',
      landingPath: '/pricing?email=someone@example.com#top',
      extra: 'dropped',
    })).toEqual({
      referrerHost: 'www.google.com',
      utmSource: 'instagram',
      utmMedium: 'social',
      utmCampaign: 'launch 2026',
      landingPath: '/pricing',
    });
  });

  it('drops anything that is not what it claims to be', () => {
    expect(cleanAcquisition({ referrerHost: 'https://x.com/path', utmSource: '<script>', landingPath: 'pricing' })).toBeNull();
    expect(cleanAcquisition(null)).toBeNull();
    expect(cleanAcquisition('google')).toBeNull();
  });
});

describe('plan changes', () => {
  it('reads the direction of a tier change', () => {
    expect(planDirection('explorer', 'voyager')).toBe('new');
    expect(planDirection(undefined, 'maestro')).toBe('new');
    expect(planDirection('voyager', 'maestro')).toBe('upgrade');
    expect(planDirection('maestro', 'voyager')).toBe('downgrade');
    expect(planDirection('maestro', 'explorer')).toBe('cancel');
    expect(planDirection('voyager', 'voyager')).toBeNull();
    expect(planDirection('vip', 'voyager')).toBe('new');
  });

  it('records on the event and in the counters', async () => {
    __testUtils.seedDoc('stripeEvents', 'evt_1', { type: 'customer.subscription.updated' });
    await recordPlanChange('evt_1', { direction: 'upgrade', from: 'voyager', to: 'maestro', interval: 'year' });

    expect((__testUtils.getDoc('stripeEvents', 'evt_1') as any).planChange).toEqual({
      direction: 'upgrade', fromTier: 'voyager', toTier: 'maestro', interval: 'year',
    });
    const today = dayKey();
    expect(counters(today).planChanges).toEqual({ upgrade: 1 });
    expect(counters(today).planMoves).toEqual({ voyager_to_maestro: 1 });
  });
});
