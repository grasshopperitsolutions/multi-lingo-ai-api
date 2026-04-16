import admin from 'firebase-admin';

let app: admin.app.App;

if (!admin.apps.length) {
  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
} else {
  app = admin.app();
}

export const auth = admin.auth();
export const db = admin.firestore();
export const storage = admin.storage();
export const FieldValue = admin.firestore.FieldValue;

export default app;