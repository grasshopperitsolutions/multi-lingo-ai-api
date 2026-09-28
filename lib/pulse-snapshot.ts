/**
 * The daily Pulse snapshot: `appConfig/pulse/days/{YYYY-MM-DD}`, one recount
 * per day, written by the 06:00 UTC cron (api/email.ts) for the day that just
 * ended.
 *
 * It holds what only the server can count, or what is only ever true "now":
 * users per tier and subscription state as they stood, how many people the
 * login token says were recently here, how much of each pool exists, what the
 * personal spaces hold, where the word pool's translations came from, how
 * many translations each interface language has, and revenue from Stripe.
 * Anything that happens *during* a day is in the counters document instead
 * (lib/pulse.ts); the frontend reads both.
 *
 * Recomputed whole each run (`set`, not merge), so a second run the same day
 * simply replaces the first. Every section is computed on its own and a
 * failure is recorded in `errors` rather than thrown: a Stripe outage must not
 * cost the day its user counts, and the cron must not fail the mail queue.
 *
 * Counts only. Nothing here names a person.
 */

import { auth, db, FieldValue } from './firebase-admin';
import { tierFromPriceId } from './stripe-plans';
import { daysRef, dayKey, safeKey, toMillis } from './pulse';
import { logInfo, logWarn } from './logger';

const DAY_MS = 86_400_000;

/** Pools whose size is tracked day by day. Top-level collections only. */
export const SNAPSHOT_POOLS = [
  'stories',
  'historyFacts',
  'examExercises',
  'grammarExercises',
  'grammarTopics',
  'pronunciationPassages',
  'wordPool',
  'wordLinkGamePool',
  'wordLadderGamePool',
  'ttsClips',
  'tutors',
] as const;

/** The per-user lists of the personal space, counted as "people who keep one". */
const PERSONAL_LISTS = ['personalPhrases', 'personalMistakes', 'personalQuestions'] as const;

type Counts = Record<string, number>;
const add = (counts: Counts, key: string, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

async function section<T>(name: string, errors: Record<string, string>, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err: any) {
    errors[name] = err?.message ?? String(err);
    logWarn('pulse_snapshot_section_failed', 'pulse', { section: name, errorMessage: errors[name] });
    return null;
  }
}

/** Profiles: sizes, tiers, subscription state, sign-ups on the day. */
async function countUsers(day: string) {
  const snap = await db.collection('users')
    .select('subscriptionTier', 'subscriptionStatus', 'cancelAtPeriodEnd', 'onboardingCompleted', 'createdAt', 'lastStreakDate')
    .get();
  const byTier: Counts = {};
  const subscriptions: Counts = { active: 0, pastDue: 0, cancelled: 0, cancelScheduled: 0 };
  let onboarded = 0;
  let signUps = 0;
  let streakActive = 0;
  for (const doc of snap.docs) {
    const u = doc.data();
    add(byTier, safeKey(u.subscriptionTier ?? 'explorer'));
    if (u.onboardingCompleted === true) onboarded += 1;
    const isActive = u.subscriptionStatus === 'active' || u.subscriptionStatus === 'trialing';
    if (isActive) subscriptions.active += 1;
    if (isActive && u.cancelAtPeriodEnd) subscriptions.cancelScheduled += 1;
    if (u.subscriptionStatus === 'past_due') subscriptions.pastDue += 1;
    if (u.subscriptionStatus === 'canceled') subscriptions.cancelled += 1;
    const created = toMillis(u.createdAt);
    if (created !== null && dayKey(new Date(created)) === day) signUps += 1;
    if (u.lastStreakDate === day) streakActive += 1;
  }
  return { total: snap.size, byTier, onboarded, signUps, subscriptions, streakActive };
}

/**
 * How recently each real account's login token was renewed. Firebase renews
 * it roughly hourly while the app is open, so this is a finer "last seen"
 * than `lastStreakDate`'s one-per-day — and only the Admin SDK can read it.
 * Anonymous accounts (guests) have no provider and are left out.
 */
async function countLastSeen(nowMs: number) {
  const seen = { within1Day: 0, within7Days: 0, within30Days: 0, accounts: 0 };
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (!user.providerData?.length) continue;
      seen.accounts += 1;
      const last = Date.parse(user.metadata?.lastRefreshTime ?? user.metadata?.lastSignInTime ?? '');
      if (Number.isNaN(last)) continue;
      const age = nowMs - last;
      if (age <= DAY_MS) seen.within1Day += 1;
      if (age <= 7 * DAY_MS) seen.within7Days += 1;
      if (age <= 30 * DAY_MS) seen.within30Days += 1;
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return seen;
}

/** Each pool's size, and how much of it was created on the day. */
async function countPools(day: string) {
  const start = new Date(`${day}T00:00:00Z`);
  const end = new Date(start.getTime() + DAY_MS);
  const pools: Record<string, { total: number; createdOnDay: number }> = {};
  for (const name of SNAPSHOT_POOLS) {
    const snap = await db.collection(name).select('createdAt').get();
    let createdOnDay = 0;
    for (const doc of snap.docs) {
      const created = toMillis(doc.data().createdAt);
      if (created !== null && created >= start.getTime() && created < end.getTime()) createdOnDay += 1;
    }
    pools[name] = { total: snap.size, createdOnDay };
  }
  return pools;
}

/** Owner of a document in users/{uid}/{list}/{id}, or null elsewhere. */
function ownerUid(doc: any): string | null {
  const owner = doc.ref?.parent?.parent;
  return owner && /^users\//.test(owner.path ?? '') ? owner.id : null;
}

/** People who keep each personal list, and how many entries there are. */
async function countPersonalSpace() {
  const result: Record<string, { people: number; items: number }> = {};
  for (const list of PERSONAL_LISTS) {
    const snap = await db.collectionGroup(list).select().get();
    const owners = new Set<string>();
    let items = 0;
    for (const doc of snap.docs) {
      const uid = ownerUid(doc);
      if (!uid) continue;
      owners.add(uid);
      items += 1;
    }
    result[list] = { people: owners.size, items };
  }
  const boards = await db.collectionGroup('personalNotes').select().get();
  result.personalNotes = {
    people: new Set(boards.docs.map(ownerUid).filter(Boolean)).size,
    items: boards.size,
  };
  return result;
}

/**
 * Where the word pool's words came from ("ai", "user" — a dictionary lookup —
 * "human", "seed") and in which languages, from the `translations`
 * subcollection that holds them. The Phase 2 page could not afford this: it is
 * one read per concept from a browser.
 */
async function countWordTranslations() {
  const snap = await db.collectionGroup('translations').select('source', 'locale').get();
  const bySource: Counts = {};
  const byLocale: Counts = {};
  for (const doc of snap.docs) {
    if (!/^wordPool\//.test(doc.ref?.parent?.parent?.path ?? '')) continue;
    const data = doc.data();
    add(bySource, safeKey(data.source ?? 'unknown'));
    add(byLocale, safeKey(data.locale ?? doc.id));
  }
  return { bySource, byLocale };
}

/**
 * Translations kept per locale, for the two reading pools that translate on
 * demand: `stories/{id}/content/{locale}` and `historyFacts/{id}/content/{locale}`.
 * The document id is the locale. `examExercises` also has a `content`
 * subcollection, keyed by dialect, and is left out on purpose — an exam is
 * adapted, never translated.
 */
async function countContentTranslations() {
  const snap = await db.collectionGroup('content').select().get();
  const result: Record<string, Counts> = { stories: {}, historyFacts: {} };
  for (const doc of snap.docs) {
    const pool = (doc.ref?.parent?.parent?.path ?? '').split('/')[0];
    if (pool in result) add(result[pool], safeKey(doc.id));
  }
  return result;
}

/**
 * Monthly recurring revenue, from Stripe itself rather than from anything
 * stored here: every active or trialing subscription's price, normalised to a
 * month, in minor units (cents) per currency. A yearly plan counts a twelfth
 * of its price. Trials are counted separately and left out of MRR, since
 * nothing has been paid yet.
 */
async function countRevenue() {
  // Loaded here, not at module scope: lib/stripe.ts constructs its client on
  // import and throws without a key, and this module is imported by the cron
  // in api/email.ts. At module scope a Stripe misconfiguration would stop the
  // contact form and the mail queue loading at all (see "ERR_REQUIRE_ESM has
  // now cost two outages" in CLAUDE.md for the general rule). Here it costs
  // the snapshot its revenue section.
  const { stripe } = await import('./stripe.js');
  const mrr: Record<string, number> = {};
  const byTier: Record<string, { subscriptions: number; mrr: Record<string, number> }> = {};
  let active = 0;
  let trialing = 0;
  for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 }) as AsyncIterable<any>) {
    if (sub.status === 'trialing') {
      trialing += 1;
      continue;
    }
    if (sub.status !== 'active' && sub.status !== 'past_due') continue;
    active += 1;
    for (const item of sub.items?.data ?? []) {
      const price = item.price ?? {};
      const amount = (price.unit_amount ?? 0) * (item.quantity ?? 1);
      const interval = price.recurring?.interval ?? 'month';
      const every = price.recurring?.interval_count ?? 1;
      const perMonth = interval === 'year' ? amount / (12 * every)
        : interval === 'week' ? (amount * 52) / (12 * every)
        : interval === 'day' ? (amount * 365) / (12 * every)
        : amount / every;
      const currency = safeKey(price.currency ?? 'unknown');
      const tier = tierFromPriceId(price.id);
      mrr[currency] = Math.round((mrr[currency] ?? 0) + perMonth);
      byTier[tier] ??= { subscriptions: 0, mrr: {} };
      byTier[tier].subscriptions += 1;
      byTier[tier].mrr[currency] = Math.round((byTier[tier].mrr[currency] ?? 0) + perMonth);
    }
  }
  return { mrr, byTier, active, trialing };
}

/**
 * Compute and store the snapshot for `day` (default: yesterday, UTC — the
 * cron runs at 06:00 for the day that just ended). Never throws.
 */
export async function writeDailySnapshot(now: Date = new Date(), day: string = dayKey(new Date(now.getTime() - DAY_MS))) {
  const errors: Record<string, string> = {};
  const [users, lastSeen, pools, personalSpace, wordTranslations, contentTranslations, revenue] = await Promise.all([
    section('users', errors, () => countUsers(day)),
    section('lastSeen', errors, () => countLastSeen(now.getTime())),
    section('pools', errors, () => countPools(day)),
    section('personalSpace', errors, () => countPersonalSpace()),
    section('wordTranslations', errors, () => countWordTranslations()),
    section('contentTranslations', errors, () => countContentTranslations()),
    section('revenue', errors, () => countRevenue()),
  ]);

  const snapshot = {
    day,
    users,
    lastSeen,
    pools,
    personalSpace,
    wordTranslations,
    contentTranslations,
    revenue,
    errors,
    computedAt: FieldValue.serverTimestamp(),
  };

  try {
    await daysRef(day).set(snapshot);
    logInfo('pulse_snapshot_written', 'pulse', { day, failedSections: Object.keys(errors).join(',') || 'none' });
    return { day, ok: true, failedSections: Object.keys(errors) };
  } catch (err: any) {
    logWarn('pulse_snapshot_failed', 'pulse', { day, errorMessage: err?.message ?? 'unknown' });
    return { day, ok: false, failedSections: Object.keys(errors) };
  }
}
