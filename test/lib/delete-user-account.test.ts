import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));
vi.mock('../../lib/stripe', () => import('../helpers/mockStripe'));

import { __testUtils as fbUtils } from '../helpers/mockFirebaseAdmin';
import { __testUtils as stripeUtils, stripe } from '../helpers/mockStripe';
import { deleteUserAccount } from '../../lib/delete-user-account';

beforeEach(() => {
  fbUtils.reset();
  stripeUtils.reset();
});

describe('deleteUserAccount', () => {
  it('cancels the Stripe subscription, deletes the Firestore doc + sub-collections, files, and the Auth record', async () => {
    fbUtils.seedAuthUser('alice');
    fbUtils.seedDoc('users', 'alice', { stripeSubscriptionId: 'sub_alice' });
    stripeUtils.seedSubscription('sub_alice', { status: 'active' });
    fbUtils.seedDoc('users/alice/notes', 'n1', { text: 'hi' });
    fbUtils.seedDoc('users/alice/notes/n1/replies', 'r1', { text: 'reply' });
    fbUtils.seedDoc('files', 'f1', { userId: 'alice' });
    fbUtils.seedDoc('files', 'f2', { userId: 'bob' });
    fbUtils.seedStorageFile('avatars/alice/pic.png');
    fbUtils.seedStorageFile('uploads/alice/doc.pdf');

    await deleteUserAccount('alice');

    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_alice');
    expect(fbUtils.getDoc('users', 'alice')).toBeUndefined();
    expect(fbUtils.getDoc('users/alice/notes', 'n1')).toBeUndefined();
    expect(fbUtils.getDoc('users/alice/notes/n1/replies', 'r1')).toBeUndefined();
    expect(fbUtils.getDoc('files', 'f1')).toBeUndefined();
    expect(fbUtils.getDoc('files', 'f2')).toBeDefined(); // not alice's, untouched
    expect(fbUtils.hasStorageFile('avatars/alice/pic.png')).toBe(false);
    expect(fbUtils.hasStorageFile('uploads/alice/doc.pdf')).toBe(false);
  });

  it('skips the Stripe cancel call when the user has no subscription', async () => {
    fbUtils.seedAuthUser('bob');
    fbUtils.seedDoc('users', 'bob', {});
    await deleteUserAccount('bob');
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('continues past a failed Stripe cancel (non-fatal, best-effort)', async () => {
    fbUtils.seedAuthUser('carol');
    fbUtils.seedDoc('users', 'carol', { stripeSubscriptionId: 'sub_missing' });
    // sub_missing was never seeded in mockStripe -> subscriptions.cancel throws "No such subscription"
    await expect(deleteUserAccount('carol')).resolves.toBeUndefined();
    expect(fbUtils.getDoc('users', 'carol')).toBeUndefined();
  });

  it('skips Firestore doc deletion entirely when the doc never existed', async () => {
    fbUtils.seedAuthUser('dave');
    await expect(deleteUserAccount('dave')).resolves.toBeUndefined();
  });

  it('is still deleted from Auth even if nothing else exists for that uid', async () => {
    fbUtils.seedAuthUser('erin');
    await deleteUserAccount('erin');
    await expect(async () => {
      const { auth } = await import('../helpers/mockFirebaseAdmin');
      await auth.getUser('erin');
    }).rejects.toThrow();
  });
});
