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
 * `lastStreakDate`, though, is written by the frontend as a **UTC** date with
 * no time on it, so mapping it onto a local day is ambiguous by up to a day and
 * has to be resolved on purpose rather than by accident. See
 * `activeUtcDatesForLocalDay` for which way it is resolved and why the obvious
 * alternative is worse.
 */

export type ReminderTemplate =
  | 'weekly_review'
  | 'streak_rescue'
  | 'lessons_low'
  | 'practice_nudge';

/**
 * Ranked. The first candidate that is enabled, due and not already sent today
 * is the one that goes out.
 *
 * Weekly first because it is the only one that is not a nudge — it is the
 * message people actually like receiving, and it fires once a week. Streak
 * rescue above the plain nudge because "you are about to lose a 12-day streak"
 * is worth interrupting someone for and "you haven't practised" mostly is not;
 * where both apply, the rescue is strictly the better message.
 */
export const REMINDER_ORDER: ReminderTemplate[] = [
  'weekly_review',
  'streak_rescue',
  'lessons_low',
  'practice_nudge',
];

/** A streak shorter than this is not worth interrupting someone to save. */
export const STREAK_RESCUE_MIN_DAYS = 3;

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
  streakRescue: boolean;
  practiceNudge: boolean;
  lessonsLow: boolean;
  weeklyReview: boolean;
}

/**
 * All four on. Turning on notifications is an explicit, deliberate act — the
 * user pressed a button and then a browser dialog — so defaulting the content
 * to off would mean they granted permission and then received nothing.
 *
 * The plain nudge being on is safe because it can never stack with the streak
 * rescue: they are ranked, and only one is ever sent.
 */
export const DEFAULT_REMINDER_PREFS: ReminderPrefs = {
  hour: 19,
  weekday: 0,
  streakRescue: true,
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
  for (const key of ['streakRescue', 'practiceNudge', 'lessonsLow', 'weeklyReview'] as const) {
    if (typeof raw[key] === 'boolean') result[key] = raw[key] as boolean;
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

export interface ReminderInput {
  prefs: ReminderPrefs;
  local: LocalParts;
  /** users/{uid}.dayStreak */
  dayStreak: number;
  /** users/{uid}.lastStreakDate, a UTC YYYY-MM-DD. */
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
  const { prefs, local, dayStreak, lastStreakDate, sentAt, lessonsRemaining, now = new Date() } = input;

  // Everything is delivered at the user's chosen hour; the weekly review just
  // additionally requires the right day.
  if (local.hour !== prefs.hour) return null;

  const practisedToday = lastStreakDate
    ? activeUtcDatesForLocalDay(local, now).includes(lastStreakDate)
    : false;

  const isDue: Record<ReminderTemplate, boolean> = {
    weekly_review: prefs.weeklyReview && local.weekday === prefs.weekday,
    streak_rescue: prefs.streakRescue && dayStreak >= STREAK_RESCUE_MIN_DAYS && !practisedToday,
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
    // their evening hour that their streak is about to break.
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
