import { auth, db, storage } from './firebase-admin';
import { stripe } from './stripe';
import { logWarn } from './logger';

/**
 * Recursively deletes all sub-collections under a Firestore document.
 * Firebase Admin does NOT cascade-delete sub-collections automatically.
 */
async function deleteSubCollections(docPath: string): Promise<void> {
  const docRef = db.doc(docPath);
  const subCollections = await docRef.listCollections();
  for (const subCol of subCollections) {
    const snap = await subCol.get();
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    if (!snap.empty) await batch.commit();
    for (const d of snap.docs) {
      await deleteSubCollections(d.ref.path);
    }
  }
}

/**
 * Permanently deletes a user's entire account — Stripe subscription,
 * Firestore doc + sub-collections, owned `files` docs, Storage uploads, and
 * finally the Firebase Auth record. Shared by the self-service delete
 * (DELETE /api/auth) and the admin-driven delete (DELETE /api/admin-users)
 * so both stay in lockstep.
 */
export async function deleteUserAccount(uid: string): Promise<void> {
  // 1. Cancel any active Stripe subscription (best-effort, non-fatal) —
  //    deleting the account must not leave the customer billed forever
  //    for a service they can no longer access.
  const userDocRef = db.collection('users').doc(uid);
  const userDoc = await userDocRef.get();
  const subscriptionId = userDoc.data()?.stripeSubscriptionId;

  if (subscriptionId) {
    try {
      await stripe.subscriptions.cancel(subscriptionId);
    } catch (stripeErr: any) {
      logWarn('account_delete_stripe_cancel_failed', 'delete-user-account', {
        uid,
        subscriptionId,
        reason: stripeErr?.message,
      });
    }
  }

  // 2. Delete Firestore user document + sub-collections
  if (userDoc.exists) {
    await deleteSubCollections(`users/${uid}`);
    await userDocRef.delete();
  }

  // 3. Delete all documents in the files collection owned by this user
  try {
    const filesSnap = await db
      .collection('files')
      .where('userId', '==', uid)
      .get();
    const batch = db.batch();
    filesSnap.docs.forEach((doc) => batch.delete(doc.ref));
    if (!filesSnap.empty) await batch.commit();
  } catch (firestoreErr: any) {
    logWarn('account_delete_firestore_cleanup_failed', 'delete-user-account', {
      uid,
      reason: firestoreErr?.message,
    });
  }

  // 4. Delete all user-uploaded files from Cloud Storage (best-effort, non-fatal)
  try {
    const bucket = storage.bucket();
    await bucket.deleteFiles({ prefix: `avatars/${uid}/` });
    await bucket.deleteFiles({ prefix: `uploads/${uid}/` });
  } catch (storageErr: any) {
    logWarn('account_delete_storage_cleanup_failed', 'delete-user-account', {
      uid,
      reason: storageErr?.message,
    });
  }

  // 5. Delete Firebase Auth account — point of no return
  await auth.deleteUser(uid);
}
