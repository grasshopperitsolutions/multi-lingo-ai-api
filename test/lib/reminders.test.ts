import { describe, it, expect } from 'vitest';
import {
  chooseReminder,
  localParts,
  needsLessonsRead,
  normalizeReminderPrefs,
  activeUtcDatesForLocalDay,
  daysBetween,
  DEFAULT_REMINDER_PREFS,
  LESSONS_LOW_COOLDOWN_DAYS,
} from '../../lib/reminders';

/**
 * Which reminder fires, when, in whose timezone.
 *
 * This is the half of the reminder system that can be wrong without anything
 * crashing: a user gets two notifications instead of one, or gets told to save
 * a streak they already saved, or gets nothing because their clock disagrees
 * with the server's. None of that surfaces in a log.
 */

const base = {
  prefs: DEFAULT_REMINDER_PREFS,
  dayStreak: 0,
  sentAt: {} as Record<string, string>,
};

/** 19:00 on a Wednesday in Lisbon. */
const wednesdayEvening = new Date('2026-09-16T18:00:00Z');
const lisbonEvening = localParts('Europe/Lisbon', wednesdayEvening)!;

describe('localParts', () => {
  it('reads the wall clock in the given zone, not the server', () => {
    const parts = localParts('Asia/Tokyo', new Date('2026-09-16T10:00:00Z'))!;
    expect(parts.hour).toBe(19);
    expect(parts.date).toBe('2026-09-16');
  });

  it('returns null for a missing or unusable zone, so the caller can skip', () => {
    // Skipping is the point: defaulting to UTC would deliver at the wrong hour,
    // which is worse than not delivering.
    expect(localParts(null)).toBeNull();
    expect(localParts('')).toBeNull();
    expect(localParts('Not/AZone')).toBeNull();
  });

  it('reports midnight as hour 0, not 24', () => {
    const parts = localParts('Europe/Lisbon', new Date('2026-01-15T00:30:00Z'))!;
    expect(parts.hour).toBe(0);
  });
});

describe('activeUtcDatesForLocalDay', () => {
  it('spans two UTC dates when the local evening is already tomorrow in UTC', () => {
    // 19:00 in Cancun (UTC-5) is 00:00 UTC the next day. A user who practised
    // that afternoon has lastStreakDate = the earlier UTC date, and comparing
    // against UTC "today" alone would call them inactive.
    const now = new Date('2026-09-17T00:00:00Z');
    const local = localParts('America/Cancun', now)!;
    const dates = activeUtcDatesForLocalDay(local, now);

    expect(dates).toContain('2026-09-16');
    expect(dates).toContain('2026-09-17');
  });

  it('is a single date when the local date and the UTC date agree', () => {
    // The whole point of the narrower rule: yesterday must NOT be in here, or
    // someone who last practised yesterday reads as active today.
    const now = new Date('2026-09-16T12:00:00Z');
    const local = localParts('Europe/Lisbon', now)!;
    expect(activeUtcDatesForLocalDay(local, now)).toEqual(['2026-09-16']);
  });
});

describe('chooseReminder', () => {
  it('returns null in the 23 hours that are not the user\'s', () => {
    const local = localParts('Europe/Lisbon', new Date('2026-09-16T09:00:00Z'))!;
    expect(chooseReminder({ ...base, local, now: new Date('2026-09-16T09:00:00Z') })).toBeNull();
  });

  it('sends at most one reminder even when several are due', () => {
    // A Sunday evening with a live streak and no practice today: the weekly
    // review, the streak rescue and the plain nudge all qualify.
    const now = new Date('2026-09-20T18:00:00Z'); // Sunday
    const local = localParts('Europe/Lisbon', now)!;

    const chosen = chooseReminder({
      ...base, local, now,
      dayStreak: 12,
      lastStreakDate: '2026-09-19',
    });

    expect(chosen).toBe('weekly_review');
  });

  it('prefers the streak rescue to the plain nudge', () => {
    const chosen = chooseReminder({
      ...base, local: lisbonEvening, now: wednesdayEvening,
      dayStreak: 12,
      lastStreakDate: '2026-09-15',
    });
    expect(chosen).toBe('streak_rescue');
  });

  it('falls back to the nudge when the streak is too short to be worth saving', () => {
    const chosen = chooseReminder({
      ...base, local: lisbonEvening, now: wednesdayEvening,
      dayStreak: 1,
      lastStreakDate: '2026-09-15',
    });
    expect(chosen).toBe('practice_nudge');
  });

  it('says nothing to someone who already practised today', () => {
    const chosen = chooseReminder({
      ...base, local: lisbonEvening, now: wednesdayEvening,
      dayStreak: 12,
      lastStreakDate: '2026-09-16',
    });
    expect(chosen).toBeNull();
  });

  it('does not repeat a template already sent on the user\'s local date', () => {
    const chosen = chooseReminder({
      ...base, local: lisbonEvening, now: wednesdayEvening,
      dayStreak: 12,
      lastStreakDate: '2026-09-15',
      sentAt: { streak_rescue: '2026-09-16' },
    });
    // Falls through to the next candidate rather than going silent.
    expect(chosen).toBe('practice_nudge');
  });

  it('honours a switched-off reminder', () => {
    const chosen = chooseReminder({
      ...base,
      prefs: { ...DEFAULT_REMINDER_PREFS, streakRescue: false, practiceNudge: false },
      local: lisbonEvening, now: wednesdayEvening,
      dayStreak: 12,
      lastStreakDate: '2026-09-15',
    });
    expect(chosen).toBeNull();
  });

  it('warns about low lessons, then stays quiet for the cooldown', () => {
    const due = chooseReminder({
      ...base,
      prefs: { ...DEFAULT_REMINDER_PREFS, streakRescue: false, practiceNudge: false },
      local: lisbonEvening, now: wednesdayEvening,
      lessonsRemaining: 1,
    });
    expect(due).toBe('lessons_low');

    // Sitting at one lesson for a month must not mean a push every evening.
    const tooSoon = chooseReminder({
      ...base,
      prefs: { ...DEFAULT_REMINDER_PREFS, streakRescue: false, practiceNudge: false },
      local: lisbonEvening, now: wednesdayEvening,
      lessonsRemaining: 1,
      sentAt: { lessons_low: '2026-09-14' },
    });
    expect(tooSoon).toBeNull();
  });
});

describe('needsLessonsRead', () => {
  it('is false in the hours that are not the user\'s, so the extra read is never paid for', () => {
    const offHour = localParts('Europe/Lisbon', new Date('2026-09-16T09:00:00Z'))!;
    expect(needsLessonsRead(DEFAULT_REMINDER_PREFS, offHour, {})).toBe(false);
  });

  it('is false while the cooldown is running', () => {
    expect(
      needsLessonsRead(DEFAULT_REMINDER_PREFS, lisbonEvening, { lessons_low: '2026-09-15' }),
    ).toBe(false);
  });

  it('is true at the right hour with the reminder on and the cooldown expired', () => {
    expect(needsLessonsRead(DEFAULT_REMINDER_PREFS, lisbonEvening, {})).toBe(true);
  });
});

describe('normalizeReminderPrefs', () => {
  it('defaults everything on, because granting permission and receiving nothing is worse', () => {
    const prefs = normalizeReminderPrefs(undefined);
    expect(prefs).toEqual(DEFAULT_REMINDER_PREFS);
  });

  it('rejects an hour outside the clock rather than scheduling into nowhere', () => {
    expect(normalizeReminderPrefs({ hour: 25 }).hour).toBe(DEFAULT_REMINDER_PREFS.hour);
    expect(normalizeReminderPrefs({ hour: -1 }).hour).toBe(DEFAULT_REMINDER_PREFS.hour);
    expect(normalizeReminderPrefs({ hour: 6.5 }).hour).toBe(DEFAULT_REMINDER_PREFS.hour);
    expect(normalizeReminderPrefs({ hour: 0 }).hour).toBe(0);
  });

  it('keeps the defaults for anything malformed', () => {
    const prefs = normalizeReminderPrefs({ streakRescue: 'yes', weekday: 9 });
    expect(prefs.streakRescue).toBe(true);
    expect(prefs.weekday).toBe(DEFAULT_REMINDER_PREFS.weekday);
  });
});

describe('daysBetween', () => {
  it('treats a missing stamp as infinitely long ago, so a first send is never blocked', () => {
    expect(daysBetween(undefined, '2026-09-16')).toBe(Infinity);
    expect(daysBetween('nonsense', '2026-09-16')).toBe(Infinity);
  });

  it('counts whole days', () => {
    expect(daysBetween('2026-09-09', '2026-09-16')).toBe(LESSONS_LOW_COOLDOWN_DAYS);
  });
});
