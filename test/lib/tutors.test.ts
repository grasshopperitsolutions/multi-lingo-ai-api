import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils as fb } from '../helpers/mockFirebaseAdmin';
import {
  TUTORS_COLLECTION,
  TUTOR_APPLICATIONS,
  TUTOR_TIERS,
  tierCanTutor,
  syncTutorPublication,
  deleteTutorData,
} from '../../lib/tutors';

beforeEach(() => {
  fb.reset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('lib/tutors — tier eligibility', () => {
  it('takes the tier list from the collection policy, not a second copy', () => {
    // Duplicating it here would let this file drift from the rule that
    // actually gates the write.
    expect([...TUTOR_TIERS].sort()).toEqual(['admin', 'maestro', 'vip']);
  });

  it.each(['maestro', 'vip', 'admin'])('allows %s', (tier) => {
    expect(tierCanTutor(tier)).toBe(true);
  });

  it.each(['explorer', 'voyager', undefined, ''])('refuses %s', (tier) => {
    expect(tierCanTutor(tier as string | undefined)).toBe(false);
  });
});

describe('lib/tutors — publication follows the tier', () => {
  it('hides a profile when the tier drops below the directory tiers', async () => {
    fb.seedDoc(TUTORS_COLLECTION, 'alice', { displayName: 'Alice', published: true });

    await syncTutorPublication('alice', 'explorer');

    expect(fb.getDoc(TUTORS_COLLECTION, 'alice')?.published).toBe(false);
  });

  it('restores a hidden profile when the tier comes back', async () => {
    // Hidden rather than deleted on downgrade, so resubscribing does not mean
    // writing the description and links again.
    fb.seedDoc(TUTORS_COLLECTION, 'alice', { displayName: 'Alice', published: false, description: 'kept' });

    await syncTutorPublication('alice', 'maestro');

    const stored = fb.getDoc(TUTORS_COLLECTION, 'alice');
    expect(stored?.published).toBe(true);
    expect(stored?.description).toBe('kept');
  });

  it('does not create a tutor document for a user who never had one', async () => {
    // A set-with-merge here would give every paying subscriber an empty row
    // in a publicly readable collection.
    await syncTutorPublication('bob', 'maestro');
    expect(fb.getDoc(TUTORS_COLLECTION, 'bob')).toBeUndefined();
  });

  it('leaves an already-correct profile untouched', async () => {
    fb.seedDoc(TUTORS_COLLECTION, 'alice', { published: true });
    await syncTutorPublication('alice', 'vip');
    expect(fb.getDoc(TUTORS_COLLECTION, 'alice')?.published).toBe(true);
  });

  it('never throws — a subscription change must not fail on the directory', async () => {
    await expect(syncTutorPublication('nobody', undefined)).resolves.toBeUndefined();
  });
});

describe('lib/tutors — deletion', () => {
  it('removes the public profile', async () => {
    // `tutors` is publicly readable and holds a name, email and phone, so
    // leaving it behind means personal data outliving the account.
    fb.seedDoc(TUTORS_COLLECTION, 'alice', { displayName: 'Alice', email: 'alice@example.com' });

    await deleteTutorData('alice');

    expect(fb.getDoc(TUTORS_COLLECTION, 'alice')).toBeUndefined();
  });

  it("removes that user's applications and nobody else's", async () => {
    fb.seedDoc(TUTOR_APPLICATIONS, 'a1', { applicantUid: 'alice', instagram: '@alice' });
    fb.seedDoc(TUTOR_APPLICATIONS, 'a2', { applicantUid: 'alice', instagram: '@alice2' });
    fb.seedDoc(TUTOR_APPLICATIONS, 'b1', { applicantUid: 'bob', instagram: '@bob' });

    await deleteTutorData('alice');

    const remaining = Object.values(fb.dumpCollection(TUTOR_APPLICATIONS)) as Array<{ applicantUid: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].applicantUid).toBe('bob');
  });

  it('is a no-op for a user who was never a tutor', async () => {
    await expect(deleteTutorData('bob')).resolves.toBeUndefined();
  });
});
