/**
 * Server-side upkeep for the public tutor directory.
 *
 * A tutor is a user. The document id in `tutors` is the owner's uid, which is
 * what lib/collection-policies.ts enforces with `own-doc-id` — there is no
 * such thing as a tutor profile without an account behind it. Two consequences
 * live here, both of which the client cannot do for itself:
 *
 * - When a subscription lapses, the profile has to come down. The directory
 *   cannot filter on the tutor's current tier, because reading `users` is
 *   admin-only — so the tier change has to push, and the only place that sees
 *   it is the Stripe webhook.
 * - When an account is deleted, the profile has to go with it. Otherwise a
 *   publicly readable document carrying a name, email and phone number
 *   outlives the account it belonged to, and nobody but an admin can remove
 *   it: the editor is keyed to a uid that no longer exists.
 */

import { db } from './firebase-admin';
import { resolveCollectionPolicy } from './collection-policies';
import { logInfo, logWarn } from './logger';

export const TUTORS_COLLECTION = 'tutors';
export const TUTOR_APPLICATIONS = 'appConfig/config/tutorApplications';

/**
 * Tiers allowed to be listed, read from the collection policy rather than
 * duplicated — the policy is what actually gates the write, so anything else
 * here could disagree with it.
 */
export const TUTOR_TIERS: readonly string[] =
  resolveCollectionPolicy([TUTORS_COLLECTION]).writeTiers ?? [];

/** Whether a tier may hold a published profile. */
export function tierCanTutor(tier: string | undefined): boolean {
  return Boolean(tier) && TUTOR_TIERS.includes(tier as string);
}

/**
 * Hides or restores a tutor profile to match the user's tier.
 *
 * Called from every Stripe path that changes `subscriptionTier`. The profile
 * is hidden rather than deleted, so a lapsed tutor who resubscribes gets their
 * description and links back instead of writing them again.
 *
 * Never throws — a subscription change must not fail because of the directory.
 * Only touches a document that already exists: a `set` with merge would create
 * an empty tutor row for every user who has never been one.
 */
export async function syncTutorPublication(uid: string, tier: string | undefined): Promise<void> {
  try {
    const ref = db.collection(TUTORS_COLLECTION).doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return;

    const shouldPublish = tierCanTutor(tier);
    if (snap.data()?.published === shouldPublish) return;

    await ref.update({ published: shouldPublish });

    logInfo('tutor_publication_synced', 'tutors', { uid, tier, published: shouldPublish });
  } catch (err: any) {
    logWarn('tutor_publication_sync_failed', 'tutors', { uid, tier, reason: err?.message });
  }
}

/**
 * Removes everything the directory holds about a user, for account deletion.
 *
 * Applications go too. Unlike a report — which is about content that still
 * needs fixing after the reporter leaves, and deliberately survives — an
 * application is about the person, is meaningless once the account is gone
 * (there is no longer anyone to grant a tier to), and holds their email and
 * name.
 *
 * Never throws: this runs inside the deletion cascade, where failing would
 * leave the account half-deleted.
 */
export async function deleteTutorData(uid: string): Promise<void> {
  try {
    await db.collection(TUTORS_COLLECTION).doc(uid).delete();
  } catch (err: any) {
    logWarn('tutor_profile_delete_failed', 'tutors', { uid, reason: err?.message });
  }

  try {
    // A single equality filter needs no composite index.
    const snap = await db
      .collection(TUTOR_APPLICATIONS)
      .where('applicantUid', '==', uid)
      .get();

    if (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }

    logInfo('tutor_data_deleted', 'tutors', { uid, applications: snap.size });
  } catch (err: any) {
    logWarn('tutor_applications_delete_failed', 'tutors', { uid, reason: err?.message });
  }
}
