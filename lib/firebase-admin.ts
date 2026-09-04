import { initializeApp, getApps, getApp, cert, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue as FirestoreFieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getMessaging as getAdminMessaging } from 'firebase-admin/messaging';

/**
 * firebase-admin v14 removed the legacy `admin.*` namespace entirely — there
 * is no default export, no `admin.apps`, no `admin.credential.cert()`, and no
 * global `FirebaseFirestore` type namespace. Everything now comes from the
 * per-product subpaths, and the Firestore types come from
 * 'firebase-admin/firestore' (which re-exports @google-cloud/firestore's).
 */

const REQUIRED_ENV_VARS = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'] as const;

let app: App;

if (!getApps().length) {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  app = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
} else {
  app = getApp();
}

export const auth = getAuth();
export const db = getFirestore();
export const storage = getStorage();
/**
 * Lazy: getMessaging() does credential work on first call, and every
 * handler imports this module — only the push path should pay for it.
 */
export const getMessaging = () => getAdminMessaging();
export const FieldValue = FirestoreFieldValue;

export default app;
