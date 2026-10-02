/**
 * Server side of Admin › Pulse (Phase 3 of the frontend's
 * plans/app-current-pulse.md): the counters that record what no document
 * would otherwise remember, and the daily snapshot.
 *
 *   appConfig/pulse/counters/{YYYY-MM-DD}  live increments, all day
 *   appConfig/pulse/weeks/{YYYY-Www}       unique weekly actives, by cohort
 *   appConfig/pulse/days/{YYYY-MM-DD}      one recount per day, by the cron
 *
 * Counters only ever add; the snapshot is recomputed whole, so running it
 * twice is harmless. They live in separate documents so a recount can never
 * overwrite a live increment.
 *
 * **Nothing here may fail the request that triggered it.** A counter is a
 * side effect of an AI call, a sign-in, a webhook — `bump` catches and logs,
 * and callers await it only so Vercel does not freeze the instance with the
 * write still in flight (the same reason writeTtsClip is awaited).
 *
 * Counts only: no uid, name, email or content is written to any of these
 * documents. The one per-person value is `users/{uid}.pulseSeen`, the last
 * day and week the user was counted active — a marker, not a history, and it
 * is deleted with the account.
 */

import { db, FieldValue } from './firebase-admin';
import { logWarn } from './logger';

const PULSE = () => db.collection('appConfig').doc('pulse');
export const countersRef = (day: string) => PULSE().collection('counters').doc(day);
export const weeksRef = (week: string) => PULSE().collection('weeks').doc(week);
export const daysRef = (day: string) => PULSE().collection('days').doc(day);

/** UTC day key, the same stamp aiCallsDate uses. */
export function dayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** ISO-8601 week key, e.g. "2026-W40". Weeks start on Monday, in UTC. */
export function isoWeekKey(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = d.getUTCDay() || 7;
  // The Thursday of this week decides which year the week belongs to.
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * A value made safe to use as a map key. Model names carry dots
 * ("gemini-3.5-flash"), which Firestore reads as a path separator in some
 * APIs; anything outside [A-Za-z0-9_-] becomes "_".
 */
export function safeKey(value: unknown, fallback = 'unknown'): string {
  const cleaned = String(value ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return cleaned || fallback;
}

export type Increment = [path: string[], by: number];

/**
 * [['ai','x','calls'], 1] -> { ai: { x: { calls: increment(1) } } }.
 * Repeats of one path are added together first, so a batch of events for the
 * same key is one increment rather than two that would overwrite each other.
 */
export function nestIncrements(increments: Increment[]): Record<string, unknown> {
  const totals = new Map<string, { path: string[]; by: number }>();
  for (const [path, by] of increments) {
    if (!path.length || !Number.isFinite(by) || by === 0) continue;
    const key = path.join('/');
    const entry = totals.get(key) ?? { path, by: 0 };
    entry.by += by;
    totals.set(key, entry);
  }

  const root: Record<string, any> = {};
  for (const { path, by } of totals.values()) {
    let node = root;
    for (const segment of path.slice(0, -1)) {
      node[segment] ??= {};
      node = node[segment];
    }
    node[path[path.length - 1]] = FieldValue.increment(by);
  }
  return root;
}

/**
 * Add to today's counters. Never throws.
 *
 * `set(..., { merge: true })` with nested maps rather than `update()` with
 * dotted paths: update fails on a document that does not exist yet, which is
 * every day's first event.
 */
export async function bump(increments: Increment[], date: Date = new Date()): Promise<void> {
  const data = nestIncrements(increments);
  if (Object.keys(data).length === 0) return;
  try {
    await countersRef(dayKey(date)).set(
      { ...data, day: dayKey(date), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (err: any) {
    logWarn('pulse_counter_failed', 'pulse', {
      errorMessage: err?.message ?? 'unknown',
      paths: increments.map(([path]) => path.join('.')).join(','),
    });
  }
}

// ── Known ids ───────────────────────────────────────────────────────────────
//
// Counter keys come partly from the client (which prompt an AI call was for,
// which page was opened). Accepting any string would let one caller grow a
// day's document towards Firestore's 1 MiB ceiling and break every counter
// for the rest of the day, so a key must name something that exists: a
// prompt document, or a feature document. Unknown ids count as "other".

const KNOWN_IDS_TTL_MS = 10 * 60 * 1000;
const knownIdsCache = new Map<string, { at: number; ids: Set<string> }>();

async function knownIds(collection: 'prompts' | 'features'): Promise<Set<string>> {
  const cached = knownIdsCache.get(collection);
  if (cached && Date.now() - cached.at < KNOWN_IDS_TTL_MS) return cached.ids;
  try {
    const snap = await db.collection('appConfig').doc('config').collection(collection).select().get();
    const ids = new Set<string>(snap.docs.map((d: { id: string }) => d.id));
    knownIdsCache.set(collection, { at: Date.now(), ids });
    return ids;
  } catch (err: any) {
    logWarn('pulse_known_ids_failed', 'pulse', { collection, errorMessage: err?.message ?? 'unknown' });
    return cached?.ids ?? new Set();
  }
}

/** Test seam: forget cached ids so a test's seeded documents are read. */
export function __resetKnownIds(): void {
  knownIdsCache.clear();
}

/**
 * The counter key for a client-named id: itself when it names a document in
 * `collection`, "unspecified" when absent, "other" otherwise.
 */
export async function resolveKnownId(
  value: unknown,
  collection: 'prompts' | 'features'
): Promise<string> {
  if (typeof value !== 'string' || value.trim() === '') return 'unspecified';
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return 'other';
  return (await knownIds(collection)).has(id) ? id : 'other';
}

// ── Events the browser reports (POST /api/auth, action "pulse") ─────────────

/** More than one page of events in one request is a client bug, not usage. */
export const MAX_CLIENT_EVENTS = 20;

/** A live session is minted for 15 minutes; a report above that is wrong. */
const MAX_LIVE_SECONDS = 15 * 60;

export type ClientEvent =
  | { type: 'active' }
  | { type: 'open'; feature: string }
  | { type: 'locked'; feature: string }
  | { type: 'liveSeconds'; seconds: number };

/**
 * Record what the browser reports, as counts. Returns how many events were
 * counted. Never throws: this is fire-and-forget telemetry for the caller.
 *
 * `active` is counted **once per user per day and per week**, which is what
 * makes daily actives and weekly retention exact rather than inferred from
 * `lastPracticeDate` (a latest-value field that cannot say who was here on a
 * past day). The marker is `users/{uid}.pulseSeen = { day, week }`: the last
 * day and week this user was counted, never a list of them. It is checked and
 * moved in one transaction, so two tabs opening at once count once.
 *
 * Weekly actives are kept by **sign-up week** (`cohorts`), which is all an
 * early-retention table needs: of those who joined in week N, how many were
 * active in week N+k.
 */
export async function recordClientEvents(uid: string, events: unknown, now: Date = new Date()): Promise<number> {
  if (!Array.isArray(events)) return 0;
  const today = dayKey(now);
  const week = isoWeekKey(now);
  const userRef = db.collection('users').doc(uid);

  try {
    const wantsActive = events.some((e: any) => e?.type === 'active');
    let firstToday = false;
    let firstThisWeek = false;
    let cohort = 'unknown';
    let tier = 'explorer';

    if (wantsActive) {
      await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(userRef);
        const data = snap.data() ?? {};
        tier = safeKey(data.subscriptionTier ?? 'explorer');
        const createdMs = toMillis(data.createdAt);
        cohort = createdMs === null ? 'unknown' : isoWeekKey(new Date(createdMs));
        const seen = data.pulseSeen ?? {};
        firstToday = seen.day !== today;
        firstThisWeek = seen.week !== week;
        if (snap.exists && (firstToday || firstThisWeek)) {
          tx.set(userRef, { pulseSeen: { day: today, week } }, { merge: true });
        }
        // A missing profile is counted nowhere: there is no one to count.
        if (!snap.exists) firstToday = firstThisWeek = false;
      });
    } else {
      const snap = await userRef.get();
      tier = safeKey(snap.data()?.subscriptionTier ?? 'explorer');
    }

    const increments: Increment[] = [];
    let counted = 0;
    if (firstToday) {
      increments.push([['activeUsers', 'total'], 1], [['activeUsers', tier], 1]);
    }
    for (const event of events.slice(0, MAX_CLIENT_EVENTS) as any[]) {
      if (event?.type === 'open' || event?.type === 'locked') {
        const feature = await resolveKnownId(event.feature, 'features');
        increments.push([[event.type === 'open' ? 'pageOpens' : 'locked', feature, tier], 1]);
        counted += 1;
      } else if (event?.type === 'liveSeconds') {
        const seconds = Math.round(Number(event.seconds));
        if (Number.isFinite(seconds) && seconds > 0) {
          increments.push([['liveSeconds', tier], Math.min(seconds, MAX_LIVE_SECONDS)]);
          counted += 1;
        }
      } else if (event?.type === 'active') {
        counted += 1;
      }
    }

    await bump(increments, now);
    if (firstThisWeek) {
      await weeksRef(week).set(
        {
          week,
          active: FieldValue.increment(1),
          cohorts: { [cohort]: FieldValue.increment(1) },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return counted;
  } catch (err: any) {
    logWarn('pulse_events_failed', 'pulse', { uid, errorMessage: err?.message ?? 'unknown' });
    return 0;
  }
}

/** A Firestore Timestamp, `{ _seconds }`, ISO string or Date, as epoch ms. */
export function toMillis(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'object') {
    const seconds = value._seconds ?? value.seconds;
    return typeof seconds === 'number' ? seconds * 1000 : null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

// ── Where a new user came from ──────────────────────────────────────────────

const UTM_PATTERN = /^[A-Za-z0-9 ._+-]{1,100}$/;

/**
 * The first-touch record the browser kept since landing, cleaned for storage
 * on the new profile. Keeps the referrer's **hostname only** — a full
 * referrer URL can carry somebody's search terms or session ids — the three
 * standard campaign tags, and the landing path without its query string.
 * Returns null when nothing usable is left.
 */
export function cleanAcquisition(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const out: Record<string, string> = {};

  const referrer = typeof input.referrerHost === 'string' ? input.referrerHost.trim().toLowerCase() : '';
  if (/^[a-z0-9.-]{1,253}$/.test(referrer)) out.referrerHost = referrer;

  for (const key of ['utmSource', 'utmMedium', 'utmCampaign'] as const) {
    const value = typeof input[key] === 'string' ? (input[key] as string).trim() : '';
    if (UTM_PATTERN.test(value)) out[key] = value;
  }

  const path = typeof input.landingPath === 'string' ? input.landingPath.split(/[?#]/)[0] : '';
  if (/^\/[A-Za-z0-9/_.-]{0,199}$/.test(path)) out.landingPath = path;

  return Object.keys(out).length ? out : null;
}

// ── Plan changes (api/stripe.ts webhook) ────────────────────────────────────

const PAID_RANK: Record<string, number> = { explorer: 0, voyager: 1, maestro: 2 };

export type PlanDirection = 'new' | 'upgrade' | 'downgrade' | 'cancel' | 'cancelScheduled' | 'resumed';

/**
 * Which way a tier change went. Tiers Stripe never sells (vip, admin) rank
 * with the free tier, so leaving one for a paid plan reads as "new".
 */
export function planDirection(from: string | undefined, to: string): PlanDirection | null {
  const before = PAID_RANK[from ?? 'explorer'] ?? 0;
  const after = PAID_RANK[to] ?? 0;
  if (before === after) return null;
  if (after === 0) return 'cancel';
  if (before === 0) return 'new';
  return after > before ? 'upgrade' : 'downgrade';
}

/**
 * Record one plan change: on its `stripeEvents` document (which already
 * exists — the webhook claims it for idempotency before anything runs, so a
 * retried delivery never reaches here twice) and in today's counters.
 * Never throws.
 */
export async function recordPlanChange(
  eventId: string,
  change: { direction: PlanDirection; from?: string; to: string; interval?: string | null }
): Promise<void> {
  const from = safeKey(change.from ?? 'explorer');
  const to = safeKey(change.to);
  try {
    await db.collection('stripeEvents').doc(eventId).set(
      { planChange: { direction: change.direction, fromTier: from, toTier: to, interval: change.interval ?? null } },
      { merge: true }
    );
  } catch (err: any) {
    logWarn('pulse_plan_change_failed', 'pulse', { eventId, errorMessage: err?.message ?? 'unknown' });
  }
  await bump([
    [['planChanges', change.direction], 1],
    // Only a real move between tiers; a scheduled cancellation or a
    // resumption leaves the tier where it was.
    ...(from !== to ? [[['planMoves', `${from}_to_${to}`], 1] as Increment] : []),
  ]);
}
