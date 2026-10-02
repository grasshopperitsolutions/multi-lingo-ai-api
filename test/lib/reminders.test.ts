import { describe, it, expect } from 'vitest';
import {
  chooseReminder,
  localParts,
  needsLessonsRead,
  normalizeReminderPrefs,
  activeUtcDatesForLocalDay,
  daysBetween,
  DEFAULT_REMINDER_PREFS,
  DEFAULT_WEEKLY_TARGET,
  LESSONS_LOW_COOLDOWN_DAYS,
  practiceDaysLast7,
  practiceDaysThisWeek,
  resolveWeeklyTarget,
} from '../../lib/reminders';

/**
 * Which reminder fires, when, in whose timezone.
 *
 * This is the half of the reminder system that can be wrong without anything
 * crashing: a user gets two notifications instead of one, or gets told to save
 * a goal they already met, or gets nothing because their clock disagrees
 * with the server's. None of that surfaces in a log.
 */

const base = {
  prefs: DEFAULT_REMINDER_PREFS,
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

/** 19:00 on a Thursday in Lisbon, in the week of Monday 2026-09-14. */
const thursdayEvening = new Date('2026-09-17T18:00:00Z');
const lisbonThursday = localParts('Europe/Lisbon', thursdayEvening)!;
/** 19:00 on the Saturday of that week. */
const saturdayEvening = new Date('2026-09-19T18:00:00Z');
const lisbonSaturday = localParts('Europe/Lisbon', saturdayEvening)!;

describe('chooseReminder', () => {
  it('returns null in the 23 hours that are not the user\'s', () => {
    const local = localParts('Europe/Lisbon', new Date('2026-09-16T09:00:00Z'))!;
    expect(chooseReminder({ ...base, local, now: new Date('2026-09-16T09:00:00Z') })).toBeNull();
  });

  it('sends at most one reminder even when several are due', () => {
    // A Sunday evening with no practice today: the weekly review and the plain
    // nudge both qualify (the weekly goal never goes out on a Sunday).
    const now = new Date('2026-09-20T18:00:00Z'); // Sunday
    const local = localParts('Europe/Lisbon', now)!;

    const chosen = chooseReminder({
      ...base, local, now,
      lastPracticeDate: '2026-09-19',
    });

    expect(chosen).toBe('weekly_review');
  });

  describe('the weekly-goal nudge', () => {
    it('goes out on a Thursday when the goal is still within reach', () => {
      const chosen = chooseReminder({
        ...base, local: lisbonThursday, now: thursdayEvening,
        practiceDates: ['2026-09-14'],
        lastPracticeDate: '2026-09-14',
      });
      expect(chosen).toBe('weekly_goal');
    });

    it('goes out on a Saturday, and only on Thursday and Saturday', () => {
      const input = { ...base, practiceDates: ['2026-09-14'], lastPracticeDate: '2026-09-14' };
      expect(chooseReminder({ ...input, local: lisbonSaturday, now: saturdayEvening })).toBe('weekly_goal');

      // Wednesday is a nudge day for the plain reminder, never for the goal.
      expect(chooseReminder({ ...input, local: lisbonEvening, now: wednesdayEvening })).toBe('practice_nudge');
    });

    it('stays quiet once the goal is met', () => {
      const chosen = chooseReminder({
        ...base, local: lisbonThursday, now: thursdayEvening,
        practiceDates: ['2026-09-14', '2026-09-15', '2026-09-16'],
        lastPracticeDate: '2026-09-16',
      });
      // Falls through to the plain nudge, which is a different message.
      expect(chosen).toBe('practice_nudge');
    });

    it('stays quiet when the goal can no longer be reached this week', () => {
      // Saturday with 0 of 3: Saturday and Sunday are two days, the gap is
      // three. Nagging about a target that cannot be met is the old streak
      // guilt under a new name.
      const chosen = chooseReminder({
        ...base, local: lisbonSaturday, now: saturdayEvening,
        practiceDates: [],
        lastPracticeDate: '2026-09-10',
      });
      expect(chosen).toBe('practice_nudge');
    });

    it('is still reachable on a Saturday with two days done', () => {
      const chosen = chooseReminder({
        ...base, local: lisbonSaturday, now: saturdayEvening,
        practiceDates: ['2026-09-14', '2026-09-16'],
        lastPracticeDate: '2026-09-16',
      });
      expect(chosen).toBe('weekly_goal');
    });

    it('does not count last week\'s days towards this week', () => {
      const chosen = chooseReminder({
        ...base, local: lisbonThursday, now: thursdayEvening,
        practiceDates: ['2026-09-10', '2026-09-11', '2026-09-13'], // all the week before
        lastPracticeDate: '2026-09-13',
      });
      expect(chosen).toBe('weekly_goal');
    });

    it('measures against the stored goal, defaulting to three', () => {
      const days = ['2026-09-14', '2026-09-15', '2026-09-16'];
      const common = { ...base, local: lisbonThursday, now: thursdayEvening, practiceDates: days, lastPracticeDate: '2026-09-16' };
      expect(chooseReminder({ ...common, weeklyTarget: 5 })).toBe('weekly_goal');
      expect(chooseReminder({ ...common, weeklyTarget: 3 })).toBe('practice_nudge');
      expect(chooseReminder({ ...common, weeklyTarget: 0 })).toBe('practice_nudge'); // 0 = default 3, met
    });

    it('does not fire for someone who already practised today', () => {
      const chosen = chooseReminder({
        ...base, local: lisbonThursday, now: thursdayEvening,
        practiceDates: ['2026-09-14', '2026-09-17'],
        lastPracticeDate: '2026-09-17',
      });
      expect(chosen).toBeNull();
    });
  });

  it('falls back to the plain nudge for someone with no practice history at all', () => {
    const chosen = chooseReminder({ ...base, local: lisbonEvening, now: wednesdayEvening });
    expect(chosen).toBe('practice_nudge');
  });

  it('says nothing to someone who already practised today', () => {
    const chosen = chooseReminder({
      ...base, local: lisbonEvening, now: wednesdayEvening,
      lastPracticeDate: '2026-09-16',
    });
    expect(chosen).toBeNull();
  });

  it('still reads the old UTC stamp for someone who has not opened the app since the switch', () => {
    const today = chooseReminder({
      ...base, local: lisbonEvening, now: wednesdayEvening,
      lastStreakDate: '2026-09-16',
    });
    expect(today).toBeNull();

    const yesterday = chooseReminder({
      ...base, local: lisbonEvening, now: wednesdayEvening,
      lastStreakDate: '2026-09-15',
    });
    expect(yesterday).toBe('practice_nudge');
  });

  it('trusts lastPracticeDate over a stale lastStreakDate', () => {
    const chosen = chooseReminder({
      ...base, local: lisbonEvening, now: wednesdayEvening,
      lastPracticeDate: '2026-09-15',
      lastStreakDate: '2026-09-16', // would read as practised today, but is the old field
    });
    expect(chosen).toBe('practice_nudge');
  });

  it('does not repeat a template already sent on the user\'s local date', () => {
    const chosen = chooseReminder({
      ...base, local: lisbonThursday, now: thursdayEvening,
      practiceDates: ['2026-09-14'],
      lastPracticeDate: '2026-09-14',
      sentAt: { weekly_goal: '2026-09-17' },
    });
    // Falls through to the next candidate rather than going silent.
    expect(chosen).toBe('practice_nudge');
  });

  it('honours a switched-off reminder', () => {
    const chosen = chooseReminder({
      ...base,
      prefs: { ...DEFAULT_REMINDER_PREFS, weeklyGoal: false, practiceNudge: false },
      local: lisbonThursday, now: thursdayEvening,
      practiceDates: ['2026-09-14'],
      lastPracticeDate: '2026-09-14',
    });
    expect(chosen).toBeNull();
  });

  it('warns about low lessons, then stays quiet for the cooldown', () => {
    const due = chooseReminder({
      ...base,
      prefs: { ...DEFAULT_REMINDER_PREFS, weeklyGoal: false, practiceNudge: false },
      local: lisbonEvening, now: wednesdayEvening,
      lessonsRemaining: 1,
    });
    expect(due).toBe('lessons_low');

    // Sitting at one lesson for a month must not mean a push every evening.
    const tooSoon = chooseReminder({
      ...base,
      prefs: { ...DEFAULT_REMINDER_PREFS, weeklyGoal: false, practiceNudge: false },
      local: lisbonEvening, now: wednesdayEvening,
      lessonsRemaining: 1,
      sentAt: { lessons_low: '2026-09-14' },
    });
    expect(tooSoon).toBeNull();
  });
});

describe('practice day counting', () => {
  it('counts the ISO week, Monday first, up to and including today', () => {
    // Wednesday 2026-09-16: the week is 14th to 16th so far.
    const dates = ['2026-09-13', '2026-09-14', '2026-09-16', '2026-09-17'];
    expect(practiceDaysThisWeek(dates, '2026-09-16')).toBe(2);
  });

  it('counts a week that crosses a month boundary', () => {
    expect(practiceDaysThisWeek(['2026-09-29', '2026-09-30', '2026-10-01'], '2026-10-01')).toBe(3);
  });

  it('counts the last seven days, not the calendar week', () => {
    // Monday 2026-09-21: the window reaches back to Tuesday the 15th.
    const dates = ['2026-09-14', '2026-09-15', '2026-09-20', '2026-09-21'];
    expect(practiceDaysLast7(dates, '2026-09-21')).toBe(3);
  });

  it('ignores junk and duplicates', () => {
    expect(practiceDaysThisWeek(undefined, '2026-09-16')).toBe(0);
    expect(practiceDaysThisWeek(['2026-09-16', '2026-09-16', 5 as unknown as string], '2026-09-16')).toBe(1);
  });

  it('resolves a goal to a whole number of days in a week, defaulting to three', () => {
    expect(resolveWeeklyTarget(undefined)).toBe(DEFAULT_WEEKLY_TARGET);
    expect(resolveWeeklyTarget(0)).toBe(3);
    expect(resolveWeeklyTarget(4)).toBe(4);
    expect(resolveWeeklyTarget(30)).toBe(7);
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
    const prefs = normalizeReminderPrefs({ weeklyGoal: 'yes', weekday: 9 });
    expect(prefs.weeklyGoal).toBe(true);
    expect(prefs.weekday).toBe(DEFAULT_REMINDER_PREFS.weekday);
  });

  it('carries an old streak-reminder opt-out over to its replacement', () => {
    expect(normalizeReminderPrefs({ streakRescue: false }).weeklyGoal).toBe(false);
    // Someone who left the old one on is simply on.
    expect(normalizeReminderPrefs({ streakRescue: true }).weeklyGoal).toBe(true);
    // An explicit answer to the new one wins.
    expect(normalizeReminderPrefs({ streakRescue: false, weeklyGoal: true }).weeklyGoal).toBe(true);
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
