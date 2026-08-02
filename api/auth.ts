import { auth, db, storage, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { logInfo, logWarn, logError, startTimer } from '../lib/logger';
import type { VercelRequest, VercelResponse } from '../lib/types';

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);

  if (handleCors(req, res)) return;

  /**
   * DELETE /api/auth
   * Permanently deletes the authenticated user's entire account.
   */
  if (req.method === 'DELETE') {
    const elapsed = startTimer();
    const uid = await verifyAuth(req, res);
    if (!uid) return;

    logInfo('account_delete_start', 'auth', { uid, method: req.method });

    try {
      // 1. Delete Firestore user document + sub-collections
      const userDocRef = db.collection('users').doc(uid);
      const userDoc = await userDocRef.get();
      if (userDoc.exists) {
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
        logWarn('account_delete_firestore_cleanup_failed', 'auth', {
          uid,
          reason: firestoreErr?.message,
        });
        console.warn(`Firestore files cleanup warning uid=${uid}:`, firestoreErr?.message);
      }

      // 3. Delete all user-uploaded files from Cloud Storage (best-effort, non-fatal)
      try {
        const bucket = storage.bucket();
        await bucket.deleteFiles({ prefix: `avatars/${uid}/` });
        await bucket.deleteFiles({ prefix: `uploads/${uid}/` });
      } catch (storageErr: any) {
        logWarn('account_delete_storage_cleanup_failed', 'auth', {
          uid,
          reason: storageErr?.message,
        });
        console.warn(`Storage cleanup warning uid=${uid}:`, storageErr?.message);
      }

      // 4. Delete Firebase Auth account — point of no return
      await auth.deleteUser(uid);

      logInfo('account_deleted', 'auth', {
        uid,
        method: req.method,
        statusCode: 200,
        durationMs: elapsed(),
      });

      return successResponse(res, {
        message: 'Account deleted successfully',
        uid,
      });
    } catch (error: any) {
      logError('account_delete_failed', 'auth', {
        uid,
        method: req.method,
        statusCode: 500,
        durationMs: elapsed(),
        errorMessage: error?.message,
      });
      return errorResponse(res, error.message || 'Account deletion failed', 500);
    }
  }

  /**
   * POST /api/auth
   * Handles social login actions. Only `google` is fully implemented today;
   * `apple`, `facebook`, and `twitter` are recognized but rejected with a
   * 501 until their provider setup is complete — this is the single source
   * of truth for which social providers are actually available.
   */
  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const elapsed = startTimer();

  try {
    const { action } = req.body;

    if (!action) {
      return errorResponse(res, 'Action is required', 400);
    }

    switch (action) {
      case 'logout': {
        logInfo('user_logout', 'auth', { method: req.method, statusCode: 200 });
        return successResponse(res, { message: 'Logged out successfully' });
      }

      case 'apple':
      case 'facebook':
      case 'twitter': {
        const providerLabels: Record<string, string> = {
          apple: 'Apple',
          facebook: 'Facebook',
          twitter: 'X',
        };

        logInfo('social_login_not_implemented', 'auth', {
          method: req.method,
          provider: action,
          statusCode: 501,
          durationMs: elapsed(),
        });

        return errorResponse(res, `Sign-in with ${providerLabels[action]} is not yet available`, 501);
      }

      case 'google': {
        const { idToken } = req.body;

        if (!idToken) {
          return errorResponse(res, 'ID token is required', 400);
        }

        const decodedToken = await auth.verifyIdToken(idToken);

        let userRecord;
        let isNewUser = false;
        try {
          userRecord = await auth.getUser(decodedToken.uid);
        } catch {
          isNewUser = true;
          userRecord = await auth.createUser({
            uid: decodedToken.uid,
            email: decodedToken.email,
            displayName: decodedToken.name,
            photoURL: decodedToken.picture,
            emailVerified: decodedToken.email_verified
          });
        }

        const userDocRef = db.collection('users').doc(userRecord.uid);
        const userDocSnap = await userDocRef.get();

        if (!userDocSnap.exists) {
          await userDocRef.set({
            email: userRecord.email,
            displayName: userRecord.displayName || decodedToken.name || '',
            photoURL: userRecord.photoURL || decodedToken.picture || null,
            emailVerified: userRecord.emailVerified,
            provider: action,
            interfaceLang: 'en',
            theme: 'light',
            subscriptionTier: 'explorer',
            subscriptionStatus: null,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          await userDocRef.update({
            displayName: userRecord.displayName || decodedToken.name || '',
            photoURL: userRecord.photoURL || decodedToken.picture || null,
            emailVerified: userRecord.emailVerified,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        const customToken = await auth.createCustomToken(userRecord.uid);

        logInfo('user_login', 'auth', {
          uid: userRecord.uid,
          method: req.method,
          provider: action,
          isNewUser,
          statusCode: 200,
          durationMs: elapsed(),
        });

        return successResponse(res, {
          uid: userRecord.uid,
          email: userRecord.email,
          displayName: userRecord.displayName || decodedToken.name || '',
          photoURL: userRecord.photoURL || decodedToken.picture || null,
          customToken
        });
      }

      default:
        return errorResponse(res, 'Invalid action', 400);
    }

  } catch (error: any) {
    logError('auth_failed', 'auth', {
      method: req.method,
      statusCode: 401,
      durationMs: elapsed(),
      errorMessage: error?.message,
    });
    return errorResponse(res, error.message || 'Authentication failed', 401);
  }
}
