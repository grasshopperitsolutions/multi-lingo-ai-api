import type { VercelRequest, VercelResponse } from '../lib/types';
import { auth, db, storage } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);

  if (handleCors(req, res)) return;

  try {
    switch (req.method) {
      /**
       * DELETE /api/user
       * Permanently deletes:
       *   1. The user's Firestore document (users/{uid})
       *   2. All files the user uploaded to Cloud Storage (avatars/{uid}/**)
       *   3. The Firebase Auth account
       *
       * Requires: Authorization: Bearer <idToken>
       */
      case 'DELETE': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        // 1. Delete Firestore user document
        const userDocRef = db.collection('users').doc(uid);
        const userDoc = await userDocRef.get();

        if (userDoc.exists) {
          await userDocRef.delete();
        }

        // 2. Delete all user-uploaded files from Cloud Storage (best-effort)
        try {
          const bucket = storage.bucket();
          // Delete avatar folder
          await bucket.deleteFiles({ prefix: `avatars/${uid}/` });
          // Delete general uploads folder
          await bucket.deleteFiles({ prefix: `uploads/${uid}/` });
        } catch (storageErr: any) {
          // Non-fatal — log and continue so Auth deletion still runs
          console.warn(`Storage cleanup warning for uid=${uid}:`, storageErr?.message);
        }

        // 3. Delete all user Firestore sub-data (files collection)
        try {
          const filesSnap = await db.collection('files').where('userId', '==', uid).get();
          const batch = db.batch();
          filesSnap.docs.forEach((doc) => batch.delete(doc.ref));
          if (!filesSnap.empty) await batch.commit();
        } catch (firestoreErr: any) {
          console.warn(`Firestore files cleanup warning for uid=${uid}:`, firestoreErr?.message);
        }

        // 4. Delete Firebase Auth account — this is the point of no return
        await auth.deleteUser(uid);

        return successResponse(res, {
          message: 'Account deleted successfully',
          uid,
        });
      }

      default:
        return errorResponse(res, 'Method not allowed', 405);
    }
  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to delete account', 500);
  }
}
