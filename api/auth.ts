import { auth, db, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { requireAdmin } from '../lib/require-admin';
import { deleteUserAccount } from '../lib/delete-user-account';
import { logInfo, logError, startTimer } from '../lib/logger';
import { reportError } from '../lib/sentry';
import { sendEmailSafe } from '../lib/email';
import { getEmailCopy, FALLBACK_LOCALE } from '../lib/email-copy';
import { welcomeEmail } from '../lib/email-templates';
import type { VercelRequest, VercelResponse } from '../lib/types';

/**
 * Firebase Admin error codes that mean "this token is no longer good",
 * which is an ordinary outcome rather than a fault: a tab left open past
 * the one-hour token lifetime, a stale client retrying, a signed-out
 * session. They still produce a 401 and a log line — they just don't
 * produce an alert, or every real sign-in bug would be buried under them.
 */
const EXPECTED_AUTH_ERROR_CODES = new Set([
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/invalid-id-token',
  'auth/session-cookie-expired',
  'auth/session-cookie-revoked',
  'auth/argument-error',
  'auth/user-not-found',
  'auth/user-disabled',
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);

  if (handleCors(req, res)) return;

  /**
   * DELETE /api/auth
   * Permanently deletes the authenticated user's entire account. Also used
   * by the admin Users panel to delete *another* user's account — pass
   * `{ uid: targetUid }` in the body, which requires the caller to be an
   * admin. Omitting the body (or matching your own uid) keeps this the
   * plain self-service delete it always was.
   */
  if (req.method === 'DELETE') {
    const elapsed = startTimer();
    const uid = await verifyAuth(req, res);
    if (!uid) return;

    const requestedTarget = req.body?.uid as string | undefined;
    let targetUid = uid;

    if (requestedTarget && requestedTarget !== uid) {
      if (!(await requireAdmin(uid, req, res))) return;

      try {
        await auth.getUser(requestedTarget);
      } catch {
        return errorResponse(res, 'User not found', 404);
      }

      targetUid = requestedTarget;
    }

    logInfo('account_delete_start', 'auth', { uid, targetUid, method: req.method });

    try {
      await deleteUserAccount(targetUid);

      logInfo('account_deleted', 'auth', {
        uid,
        targetUid,
        method: req.method,
        statusCode: 200,
        durationMs: elapsed(),
      });

      return successResponse(res, {
        message: 'Account deleted successfully',
        uid: targetUid,
      });
    } catch (error: any) {
      await reportError('account_delete_failed', 'auth', error, {
        uid,
        targetUid,
        method: req.method,
        statusCode: 500,
        durationMs: elapsed(),
      });
      return errorResponse(res, 'Account deletion failed', 500);
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

        // The browser's detected interface language, sent by the frontend's
        // socialLogin(). Seeding it here is what lets a brand-new user's
        // welcome email arrive in their own language — there is no profile
        // to read it from yet. Validated because it is client-supplied and
        // ends up as a Firestore document id in the locale lookup.
        const detectedLang = typeof req.body.interfaceLang === 'string'
          && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(req.body.interfaceLang)
            ? req.body.interfaceLang
            : FALLBACK_LOCALE;


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
            interfaceLang: detectedLang,
            theme: 'light',
            subscriptionTier: 'explorer',
            subscriptionStatus: null,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });

          // First sign-in only. sendEmailSafe never throws, so a mail
          // failure can't turn a successful sign-in into a 401 below.
          // Sent in the language the browser reported, falling back through
          // en-US to the bundled copy inside getEmailCopy.
          if (userRecord.email) {
            await sendEmailSafe(
              welcomeEmail(
                await getEmailCopy(detectedLang),
                userRecord.email,
                userRecord.displayName || decodedToken.name
              ),
              { template: 'welcome', uid: userRecord.uid, category: 'transactional' }
            );
          }
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
    // An expired or malformed ID token is a normal event — a user left a
    // tab open past the hour, or a stale client retried. Reporting those
    // would bury the failures that actually mean something (a Firestore
    // write refused mid sign-in, say) under thousands of non-issues.
    const extra = {
      method: req.method,
      statusCode: 401,
      durationMs: elapsed(),
    };
    if (EXPECTED_AUTH_ERROR_CODES.has(error?.code)) {
      logError('auth_failed', 'auth', { ...extra, errorMessage: error?.message });
    } else {
      await reportError('auth_failed', 'auth', error, extra);
    }
    return errorResponse(res, 'Authentication failed', 401);
  }
}
