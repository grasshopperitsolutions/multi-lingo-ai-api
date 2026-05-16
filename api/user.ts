import type { VercelRequest, VercelResponse } from '../lib/types';
import { auth, db, storage, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';

/** Fields the client is allowed to write via PUT /api/user */
const ALLOWED_PROFILE_FIELDS = new Set([
  'displayName',
  'interfaceLang',
  'theme',
  'photoURL',
]);

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
    // Recurse one level deeper if needed
    for (const d of snap.docs) {
      await deleteSubCollections(d.ref.path);
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleCors(req, res)) return;

  try {
    switch (req.method) {

      /**
       * GET /api/user
       * Returns the authenticated user's Firestore profile.
       * Requires: Authorization: Bearer <idToken>
       */
      case 'GET': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const docRef = db.collection('users').doc(uid);
        const doc = await docRef.get();

        if (!doc.exists) {
          return errorResponse(res, 'User profile not found', 404);
        }

        return successResponse(res, { id: doc.id, data: doc.data() });
      }

      /**
       * PUT /api/user
       * Partial-updates the authenticated user's Firestore profile.
       * Only fields in ALLOWED_PROFILE_FIELDS are accepted — all others are stripped.
       * Requires: Authorization: Bearer <idToken>
       * Body: { displayName?, interfaceLang?, theme?, photoURL? }
       */
      case 'PUT': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const body = req.body as Record<string, unknown>;

        // Strip any fields not in the allow-list
        const safeData: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(body)) {
          if (ALLOWED_PROFILE_FIELDS.has(key)) {
            safeData[key] = value;
          }
        }

        if (Object.keys(safeData).length === 0) {
          return errorResponse(res, 'No valid fields to update', 400);
        }

        const docRef = db.collection('users').doc(uid);
        await docRef.set(
          { ...safeData, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
          { merge: true }
        );

        return successResponse(res, { id: uid, updated: true });
      }

      /**
       * DELETE /api/user
       * Permanently deletes the authenticated user's entire account:
       *   1. Firestore users/{uid} document + all sub-collections
       *   2. Firestore files collection documents owned by uid
       *   3. Cloud Storage files under avatars/{uid}/ and uploads/{uid}/
       *   4. Firebase Auth account (point of no return)
       *
       * Requires: Authorization: Bearer <idToken>
       */
      case 'DELETE': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        // 1. Delete Firestore user document + sub-collections
        const userDocRef = db.collection('users').doc(uid);
        const userDoc = await userDocRef.get();
        if (userDoc.exists) {
          // Delete sub-collections first (Firebase does NOT cascade)
          await deleteSubCollections(`users/${uid}`);
          await userDocRef.delete();
        }

        // 2. Delete all documents in the files collection owned by this user
        try {
          const filesSnap = await db
            .collection('files')
            .where('userId', '==', uid)
            .get();
          const batch = db.batch();
          filesSnap.docs.forEach((doc) => batch.delete(doc.ref));
          if (!filesSnap.empty) await batch.commit();
        } catch (firestoreErr: any) {
          console.warn(`Firestore files cleanup warning uid=${uid}:`, firestoreErr?.message);
        }

        // 3. Delete all user-uploaded files from Cloud Storage (best-effort, non-fatal)
        try {
          const bucket = storage.bucket();
          await bucket.deleteFiles({ prefix: `avatars/${uid}/` });
          await bucket.deleteFiles({ prefix: `uploads/${uid}/` });
        } catch (storageErr: any) {
          console.warn(`Storage cleanup warning uid=${uid}:`, storageErr?.message);
        }

        // 4. Delete Firebase Auth account — point of no return
        await auth.deleteUser(uid);

        console.log(`Account deleted: uid=${uid} at ${new Date().toISOString()}`);

        return successResponse(res, {
          message: 'Account deleted successfully',
          uid,
        });
      }

      default:
        return errorResponse(res, 'Method not allowed', 405);
    }
  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to process user request', 500);
  }
}
