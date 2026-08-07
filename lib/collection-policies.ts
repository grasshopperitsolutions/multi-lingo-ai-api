/**
 * Per-collection read/write policy for the collections that fall outside
 * the `users` special-case in api/firestore.ts. This is the file to edit
 * when a new shared/config/pool collection needs a policy other than the
 * strict default (owner-or-admin).
 *
 * - 'public'        (read only)  — anyone with a verified Firebase session
 *                                   may read, including an anonymous/guest
 *                                   session (verifyAuth still requires a
 *                                   valid token; this only lifts the
 *                                   per-document ownership check).
 * - 'authenticated'               — any signed-in caller (including an
 *                                    anonymous session) may read/write, no
 *                                    per-document ownership check.
 * - 'admin'         (write only) — only an admin (subscriptionTier ===
 *                                   'admin') may write; reads are governed
 *                                   by the `read` policy on the same row.
 * - 'owner-or-admin'              — the strict default: only the document's
 *                                    creator (createdBy/userId) or an admin
 *                                    may read/write. This is what protects
 *                                    genuinely private data (e.g. `files`)
 *                                    and is what every unlisted collection
 *                                    falls back to.
 */

export type ReadPolicy = 'public' | 'authenticated' | 'owner-or-admin';
export type WritePolicy = 'authenticated' | 'admin' | 'owner-or-admin';

export interface CollectionPolicy {
  read: ReadPolicy;
  write: WritePolicy;
}

/** Applied to any collection path that doesn't match a row below. */
export const DEFAULT_POLICY: CollectionPolicy = { read: 'owner-or-admin', write: 'owner-or-admin' };

/**
 * Keyed by the exact collection path (segments joined with '/'), for
 * collections where siblings under the same prefix need different
 * policies — e.g. appConfig/config/locales is seedable by any signed-in
 * user, but appConfig/config/categories is admin-curated.
 */
export const EXACT_PATH_POLICIES: Record<string, CollectionPolicy> = {
  // Seeded/filled by any signed-in user (onboarding, settings, the
  // translation-fill flow) — must also be readable by guests, since the
  // landing page loads before anyone is signed in with a real account.
  'appConfig/config/locales': { read: 'public', write: 'authenticated' },
  'appConfig/config/languages': { read: 'public', write: 'authenticated' },
  'appConfig/config/writingSystems': { read: 'authenticated', write: 'authenticated' },

  // Admin-curated; every signed-in user (including guests) still needs to
  // read them (onboarding tags, login-provider toggles, AI prompt copy).
  'appConfig/config/categories': { read: 'public', write: 'authenticated' }, // users should be able to add new categories, but only admins can remove them
  'appConfig/config/authProviders': { read: 'public', write: 'admin' },
  'appConfig/config/prompts': { read: 'public', write: 'admin' },
};

/**
 * Keyed by the collection path's first segment, so a policy automatically
 * covers any subcollection nested under a matching document (e.g.
 * `wordPool/{conceptId}/translations` inherits `wordPool`'s policy).
 */
export const PREFIX_POLICIES: Record<string, CollectionPolicy> = {
  // Shared, cache-first content pools: any signed-in user reads existing
  // entries and writes newly AI-generated ones back for everyone to reuse.
  wordPool: { read: 'authenticated', write: 'authenticated' },
  wordLinkGamePool: { read: 'authenticated', write: 'authenticated' },
  wordLadderGamePool: { read: 'authenticated', write: 'authenticated' },
  examExercises: { read: 'authenticated', write: 'authenticated' },
  examImages: { read: 'authenticated', write: 'authenticated' },
};

/** Resolves the policy for an already-normalized collection path. */
export function resolveCollectionPolicy(segments: string[]): CollectionPolicy {
  const exact = EXACT_PATH_POLICIES[segments.join('/')];
  if (exact) return exact;

  const prefix = PREFIX_POLICIES[segments[0]];
  if (prefix) return prefix;

  return DEFAULT_POLICY;
}
