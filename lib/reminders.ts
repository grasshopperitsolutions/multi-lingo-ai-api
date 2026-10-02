/**
 * Practice reminders: which one is due for a user, right now, in their own
 * timezone.
 *
 * Everything here is pure. The cron in api/email.ts does the reading, the
 * sending and the date-stamping; this module only answers "given this user's
 * state and this instant, what should they get, if anything". That split is
 * what makes the interesting part testable without a scheduler, a clock or a
 * Firestore.
 *
 * ## One push per user per slot, never a pile
 *
 * `chooseReminder` returns at most one template. Four reminders that could all
 * fire on a Sunday evening would arrive as four notifications, which is how
 * people turn notifications off. They are ranked instead, and the highest
 * candidate that is both enabled and not already sent today wins.
 *
 * ## Timezones, and the one honest compromise
 *
 * A reminder is scheduled against the user's local hour, so the job runs every
 * hour and each user matches in exactly one of those runs. A user with no
 * `timezone` is skipped entirely rather than defaulted to UTC — sending at the
 * wrong hour is worse than not sending, and the field is one visit to Settings
 * away.
 *
 * `lastPracticeDate` and `practiceDates` are written by the frontend as the
 * device's own calendar day, which is the user's local day, so they compare
 * directly with `local.date`. The old `lastStreakDate` was a **UTC** date with
 * no time on it, and mapping that onto a local day is ambiguous by up to a day;
 * it is still read as a fallback for people who have not opened the app since
 * the switch. See `activeUtcDatesForLocalDay` for how that is resolved and why
 * the obvious alternative is worse.
 *
 * ## Practice days, not a streak
 *
 * The streak reminder ("don't lose your 12-day streak") became a weekly-goal
 * nudge. Nothing resets and nothing is lost by a missed day, so the message is
 * only ever "you are at 1 of 3 this week and there is still time".
 */

export type ReminderTemplate =
  | 'weekly_review'
  | 'weekly_goal'
  | 'lessons_low'
  | 'practice_nudge';

/**
 * Ranked. The first candidate that is enabled, due and not already sent today
 * is the one that goes out.
 *
 * Weekly first because it is the only one that is not a nudge — it is the
 * message people actually like receiving, and it fires once a week. The weekly
 * goal above the plain nudge because "1 of 3 this week, and there is still time"
 * is specific and worth an interruption, and "you haven't practised" mostly is
 * not; where both apply, the goal message is strictly the better one.
 */
export const REMINDER_ORDER: ReminderTemplate[] = [
  'weekly_review',
  'weekly_goal',
  'lessons_low',
  'practice_nudge',
];

/**
 * The weekdays the weekly-goal nudge may go out on, 0 = Sunday: Thursday and
 * Saturday. At most two a week by construction, and late enough in the week
 * that a missed goal is still worth saying, early enough that it is reachable.
 */
export const WEEKLY_GOAL_WEEKDAYS = [4, 6];

/** The goal when none is stored, matching the frontend's DEFAULT_WEEKLY_TARGET. */
export const DEFAULT_WEEKLY_TARGET = 3;
export const MAX_WEEKLY_TARGET = 7;

/** A stored goal, or the default for anything absent, zero or junk. */
export function resolveWeeklyTarget(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_WEEKLY_TARGET;
  return Math.min(Math.floor(n), MAX_WEEKLY_TARGET);
}

/** At or below this many lessons left, offer the nudge to book more. */
export const LESSONS_LOW_THRESHOLD = 1;

/**
 * Days before "you are nearly out of lessons" may repeat. Without it the
 * reminder fires every single day for anyone sitting at zero who has not
 * booked again, which is the definition of nagging.
 */
export const LESSONS_LOW_COOLDOWN_DAYS = 7;

export interface ReminderPrefs {
  /** Local hour, 0-23, that daily reminders are delivered at. */
  hour: number;
  /** 0 = Sunday. The day the weekly review goes out. */
  weekday: number;
  weeklyGoal: boolean;
  practiceNudge: boolean;
  lessonsLow: boolean;
  weeklyReview: boolean;
}

/**
 * All four on. Turning on notifications is an explicit, deliberate act — the
 * user pressed a button and then a browser dialog — so defaulting the content
 * to off would mean they granted permission and then received nothing.
 *
 * The plain nudge being on is safe because it can never stack with the weekly
 * goal: they are ranked, and only one is ever sent.
 */
export const DEFAULT_REMINDER_PREFS: ReminderPrefs = {
  hour: 19,
  weekday: 0,
  weeklyGoal: true,
  practiceNudge: true,
  lessonsLow: true,
  weeklyReview: true,
};

/** Merges a stored (possibly partial or junk) object over the defaults. */
export function normalizeReminderPrefs(stored: unknown): ReminderPrefs {
  const result: ReminderPrefs = { ...DEFAULT_REMINDER_PREFS };
  if (!stored || typeof stored !== 'object') return result;

  const raw = stored as Record<string, unknown>;

  if (typeof raw.hour === 'number' && Number.isInteger(raw.hour) && raw.hour >= 0 && raw.hour <= 23) {
    result.hour = raw.hour;
  }
  if (typeof raw.weekday === 'number' && Number.isInteger(raw.weekday) && raw.weekday >= 0 && raw.weekday <= 6) {
    result.weekday = raw.weekday;
  }
  for (const key of ['weeklyGoal', 'practiceNudge', 'lessonsLow', 'weeklyReview'] as const) {
    if (typeof raw[key] === 'boolean') result[key] = raw[key] as boolean;
  }
  // The streak reminder became the weekly-goal nudge. Someone who had switched
  // it off has not asked for its replacement, so the old answer carries over.
  if (typeof raw.weeklyGoal !== 'boolean' && raw.streakRescue === false) {
    result.weeklyGoal = false;
  }
  return result;
}

export interface LocalParts {
  /** YYYY-MM-DD in the user's zone. */
  date: string;
  /** 0-23 in the user's zone. */
  hour: number;
  /** 0 = Sunday, in the user's zone. */
  weekday: number;
  /** Minutes past the hour. Part of the wall clock; nothing schedules on it. */
  minute: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * The user's wall clock. Returns null for a zone Intl rejects, which is the
 * signal to skip that user rather than guess.
 */
export function localParts(timezone: string | null | undefined, now: Date = new Date()): LocalParts | null {
  if (!timezone || typeof timezone !== 'string') return null;

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
      weekday: 'short',
    }).formatToParts(now);

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

    const year = get('year');
    const month = get('month');
    const day = get('day');
    // en-CA with hour12:false yields "24" rather than "00" at midnight in some
    // engines; normalising here keeps every downstream comparison honest.
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute'));
    const weekday = WEEKDAY_INDEX[get('weekday')];

    if (!year || !month || !day || Number.isNaN(hour) || weekday === undefined) return null;

    return { date: `${year}-${month}-${day}`, hour, minute, weekday };
  } catch {
    return null;
  }
}

/** YYYY-MM-DD in UTC. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The UTC date stamps that would mean "active during the user's local today".
 *
 * `lastStreakDate` is written by the frontend as a UTC **date**, with no time,
 * so mapping it onto a local day is ambiguous by up to a day and has to be
 * resolved deliberately. The two candidates are the current UTC date and the
 * user's own local date; activity at any point during their local today lands
 * on one of them.
 *
 * In a UTC-5 zone at 19:00 local it is already tomorrow in UTC, so the pair is
 * {local today, UTC tomorrow} and someone who practised that afternoon is
 * correctly recognised. In a UTC+1 zone at 13:00 local the two collapse to one
 * date, and yesterday is correctly *not* counted.
 *
 * The earlier version of this took every UTC date the local day overlapped,
 * which sounds more precise and is worse: a local day in any non-zero offset
 * always clips the previous UTC date, so a whole extra day was accepted to
 * catch the few minutes after local midnight. A user who practised yesterday
 * read as having practised today, and the streak rescue never fired.
 */
export function activeUtcDatesForLocalDay(local: LocalParts, now: Date = new Date()): string[] {
  const today = utcDate(now);
  return today === local.date ? [today] : [local.date, today];
}

/** Whole days between two YYYY-MM-DD strings, or Infinity if `earlier` is unusable. */
export function daysBetween(earlier: string | undefined, later: string): number {
  if (!earlier) return Infinity;
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86_400_000);
}

/** A YYYY-MM-DD moved by whole days, in plain calendar arithmetic (no zone). */
export function shiftDate(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return date;
  return utcDate(new Date(t + days * 86_400_000));
}

/** The Monday of the ISO week that `date` falls in. */
export function weekStart(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return date;
  const day = new Date(t).getUTCDay(); // 0 = Sunday
  return shiftDate(date, -((day + 6) % 7));
}

/** Practice days in the ISO week ending on (and including) `localDate`. */
export function practiceDaysThisWeek(dates: string[] | undefined, localDate: string): number {
  if (!Array.isArray(dates)) return 0;
  const monday = weekStart(localDate);
  return new Set(dates.filter((d) => typeof d === 'string' && d >= monday && d <= localDate)).size;
}

/** Practice days in the seven days ending on (and including) `localDate`. */
export function practiceDaysLast7(dates: string[] | undefined, localDate: string): number {
  if (!Array.isArray(dates)) return 0;
  const from = shiftDate(localDate, -6);
  return new Set(dates.filter((d) => typeof d === 'string' && d >= from && d <= localDate)).size;
}

export interface ReminderInput {
  prefs: ReminderPrefs;
  local: LocalParts;
  /** users/{uid}.practiceDates, device-local YYYY-MM-DD. */
  practiceDates?: string[];
  /** users/{uid}.lastPracticeDate, device-local YYYY-MM-DD. */
  lastPracticeDate?: string;
  /** users/{uid}.weeklyTarget; absent or zero means the default. */
  weeklyTarget?: number;
  /**
   * users/{uid}.lastStreakDate, a UTC YYYY-MM-DD. The old field: only read when
   * there is no `lastPracticeDate`, for people who have not opened the app
   * since the switch.
   */
  lastStreakDate?: string;
  /** users/{uid}.reminderSentAt — template -> local YYYY-MM-DD it last went out. */
  sentAt: Record<string, string>;
  /**
   * personalSettings/main.lessonsRemaining. Undefined means "not read" — the
   * job only pays for that document when `lessonsLow` is on and could fire.
   */
  lessonsRemaining?: number;
  now?: Date;
}

/**
 * The one reminder due for this user right now, or null.
 *
 * Returns null for every user in all 23 of the hours that are not theirs,
 * which is what keeps an hourly job cheap.
 */
export function chooseReminder(input: ReminderInput): ReminderTemplate | null {
  const {
    prefs, local, practiceDates, lastPracticeDate, weeklyTarget, lastStreakDate, sentAt, lessonsRemaining, now = new Date(),
  } = input;

  // Everything is delivered at the user's chosen hour; the weekly review just
  // additionally requires the right day.
  if (local.hour !== prefs.hour) return null;

  const practisedToday = lastPracticeDate
    ? lastPracticeDate === local.date
    : lastStreakDate
      ? activeUtcDatesForLocalDay(local, now).includes(lastStreakDate)
      : false;

  // The goal is still reachable when the days still to come, today included
  // (the nudge only fires if today has not been practised), can close the gap.
  // Nobody is nudged about a target that can no longer be met this week.
  const target = resolveWeeklyTarget(weeklyTarget);
  const doneThisWeek = practiceDaysThisWeek(practiceDates, local.date);
  const daysLeftIncludingToday = 7 - ((local.weekday + 6) % 7);
  const goalReachable = doneThisWeek < target && target - doneThisWeek <= daysLeftIncludingToday;

  const isDue: Record<ReminderTemplate, boolean> = {
    weekly_review: prefs.weeklyReview && local.weekday === prefs.weekday,
    weekly_goal:
      prefs.weeklyGoal &&
      WEEKLY_GOAL_WEEKDAYS.includes(local.weekday) &&
      goalReachable &&
      !practisedToday,
    lessons_low:
      prefs.lessonsLow &&
      typeof lessonsRemaining === 'number' &&
      lessonsRemaining <= LESSONS_LOW_THRESHOLD &&
      daysBetween(sentAt.lessons_low, local.date) >= LESSONS_LOW_COOLDOWN_DAYS,
    practice_nudge: prefs.practiceNudge && !practisedToday,
  };

  for (const template of REMINDER_ORDER) {
    // Already sent today: not a candidate, but the next one down still is —
    // a user who got their weekly review this morning can still be told at
    // their evening hour that their weekly goal is still within reach.
    if (sentAt[template] === local.date) continue;
    if (isDue[template]) return template;
  }
  return null;
}

/**
 * Whether this user could ever need the `personalSettings/main` read.
 *
 * Called before the read so the job pays for it only for users whose hour has
 * come and who have that reminder on — otherwise an hourly job over the whole
 * user base would fetch a subcollection document per user per hour.
 */
export function needsLessonsRead(prefs: ReminderPrefs, local: LocalParts, sentAt: Record<string, string>): boolean {
  if (!prefs.lessonsLow) return false;
  if (local.hour !== prefs.hour) return false;
  if (sentAt.lessons_low === local.date) return false;
  return daysBetween(sentAt.lessons_low, local.date) >= LESSONS_LOW_COOLDOWN_DAYS;
}
