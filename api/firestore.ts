import type { VercelRequest, VercelResponse } from '../lib/types';
import { db, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';

/**
 * Resolves a slash-separated collection path to a Firestore CollectionReference.
 *
 * Supports both top-level and nested (subcollection) paths:
 *   - "users"                          → db.collection('users')
 *   - "gameWords/hangman__es-MX__food/words" → db.collection('gameWords').doc('hangman__es-MX__food').collection('words')
 *
 * Rules:
 *   - Path segments alternate: collection / document / collection / ...
 *   - A valid collection path always has an ODD number of segments (1, 3, 5, ...).
 *   - An even number of segments means the path ends on a document, which is invalid here.
 */
function resolveCollection(path: string): FirebaseFirestore.CollectionReference {
  const segments = path.split('/').map(s => s.trim()).filter(Boolean);

  if (segments.length === 0) {
    throw new Error('collection path must not be empty');
  }
  if (segments.length % 2 === 0) {
    throw new Error(
      `Invalid collection path "${path}": path has ${segments.length} segments but a collection path must have an odd number of segments (e.g. "col/docId/subCol").`
    );
  }

  // Single top-level collection
  if (segments.length === 1) {
    return db.collection(segments[0]);
  }

  // Subcollection: walk collection → doc → collection → ...
  let ref: FirebaseFirestore.DocumentReference = db
    .collection(segments[0])
    .doc(segments[1]);

  for (let i = 2; i < segments.length - 1; i += 2) {
    ref = ref.collection(segments[i]).doc(segments[i + 1]);
  }

  return ref.collection(segments[segments.length - 1]);
}

/**
 * Resolves a slash-separated document path to a Firestore DocumentReference.
 *
 * Supports both top-level and nested document paths:
 *   - "users" + "uid123"                              → db.collection('users').doc('uid123')
 *   - "gameWords/hangman__es-MX__food/words" + "wId"  → ...collection('words').doc('wId')
 */
function resolveDocument(
  collectionPath: string,
  docId: string
): FirebaseFirestore.DocumentReference {
  return resolveCollection(collectionPath).doc(docId);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);

  if (handleCors(req, res)) return;

  try {
    switch (req.method) {
      // ─────────────────────────────────────────────────────────────────────
      // POST — create a document (optionally with a specific id)
      // ─────────────────────────────────────────────────────────────────────
      case 'POST': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { collection, data, id } = req.body;

        if (!collection || !data) {
          return errorResponse(res, 'collection and data are required', 400);
        }

        const documentData = {
          ...data,
          createdBy: uid,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };

        let docRef: FirebaseFirestore.DocumentReference;

        if (id) {
          docRef = resolveDocument(collection, id);
          await docRef.set(documentData);
        } else {
          docRef = await resolveCollection(collection).add(documentData);
        }

        return successResponse(res, { id: docRef.id, collection }, 201);
      }

      // ─────────────────────────────────────────────────────────────────────
      // GET — fetch a single document OR run a filtered query
      // ─────────────────────────────────────────────────────────────────────
      case 'GET': {
        const { collection, id, query } = req.query;

        if (!collection) {
          return errorResponse(res, 'collection is required', 400);
        }

        // ── Filtered query ──
        if (query) {
          const filters =
            typeof query === 'string' ? JSON.parse(query) : query;
          const orderBy =
            (req.query.orderBy as string) || 'createdAt';
          const order =
            (req.query.order as string) || 'desc';
          const limit = parseInt(req.query.limit as string) || 20;
          const startAfter = req.query.startAfter;

          let firestoreQuery: FirebaseFirestore.Query = resolveCollection(
            collection as string
          );

          if (typeof filters === 'object' && filters !== null) {
            for (const [field, value] of Object.entries(filters)) {
              firestoreQuery = firestoreQuery.where(field, '==', value);
            }
          }

          firestoreQuery = firestoreQuery.orderBy(orderBy, order as 'asc' | 'desc');

          const pageSize = Math.min(limit, 100);
          firestoreQuery = firestoreQuery.limit(pageSize);

          if (startAfter) {
            firestoreQuery = firestoreQuery.startAfter(startAfter);
          }

          const snapshot = await firestoreQuery.get();

          if (snapshot.empty) {
            return successResponse(res, {
              documents: [],
              collection,
              hasMore: false,
            });
          }

          const documents = snapshot.docs.map((doc: FirebaseFirestore.QueryDocumentSnapshot) => ({
            id: doc.id,
            ...doc.data(),
          }));

          const lastVisible = snapshot.docs[snapshot.docs.length - 1];

          return successResponse(res, {
            documents,
            collection,
            hasMore: documents.length === pageSize,
            lastDocumentId: lastVisible ? lastVisible.id : null,
          });
        }

        // ── Single document fetch ──
        if (!id) {
          return errorResponse(
            res,
            'id is required when not running a query',
            400
          );
        }

        const docRef = resolveDocument(
          collection as string,
          id as string
        );
        const doc = await docRef.get();

        if (!doc.exists) {
          return errorResponse(res, 'Document not found', 404);
        }

        return successResponse(res, {
          id: doc.id,
          data: doc.data(),
          collection,
        });
      }

      // ─────────────────────────────────────────────────────────────────────
      // PUT — partial update of an existing document
      // ─────────────────────────────────────────────────────────────────────
      case 'PUT': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { collection, id, data } = req.body;

        if (!collection || !id || !data) {
          return errorResponse(res, 'collection, id and data are required', 400);
        }

        // ⚠️ DO NOT REMOVE — kept for reference in case RBAC is introduced in the future.
        // if (collection === 'users' && id !== uid) {
        //   return errorResponse(res, 'Unauthorized: you can only update your own profile', 403);
        // }

        const docRef = resolveDocument(collection, id);
        const doc = await docRef.get();

        if (!doc.exists) {
          return errorResponse(res, 'Document not found', 404);
        }

        // Skip ownership check for subcollections (e.g. game word pools are shared).
        // Only enforce it for top-level collections where createdBy is meaningful.
        const isTopLevel = !collection.includes('/');
        if (isTopLevel && collection !== 'users') {
          const docData = doc.data();
          if (docData?.createdBy && docData.createdBy !== uid) {
            return errorResponse(res, 'Unauthorized to update this document', 403);
          }
        }

        const updateData = {
          ...data,
          updatedBy: uid,
          updatedAt: FieldValue.serverTimestamp(),
        };

        await docRef.update(updateData);

        return successResponse(res, { id, collection, updated: true });
      }

      // ─────────────────────────────────────────────────────────────────────
      // PATCH — deep merge update (e.g. updating a single key inside a map field)
      // Uses dot-notation keys for nested field updates without overwriting siblings.
      // Body: { collection, id, data: { 'hints.en-US': 'A red fruit...' } }
      // ─────────────────────────────────────────────────────────────────────
      case 'PATCH': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { collection, id, data } = req.body;

        if (!collection || !id || !data) {
          return errorResponse(res, 'collection, id and data are required', 400);
        }

        const docRef = resolveDocument(collection, id);
        const doc = await docRef.get();

        if (!doc.exists) {
          return errorResponse(res, 'Document not found', 404);
        }

        // PATCH always uses update() (not set/merge) so dot-notation keys
        // update individual map entries without touching sibling keys.
        const patchData = {
          ...data,
          updatedBy: uid,
          updatedAt: FieldValue.serverTimestamp(),
        };

        await docRef.update(patchData);

        return successResponse(res, { id, collection, patched: true });
      }

      // ─────────────────────────────────────────────────────────────────────
      // DELETE — remove a document
      // ─────────────────────────────────────────────────────────────────────
      case 'DELETE': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { collection, id } = req.body;

        if (!collection || !id) {
          return errorResponse(res, 'collection and id are required', 400);
        }

        const docRef = resolveDocument(collection, id);
        const doc = await docRef.get();

        if (!doc.exists) {
          return errorResponse(res, 'Document not found', 404);
        }

        const docData = doc.data();
        if (docData?.createdBy && docData.createdBy !== uid) {
          return errorResponse(res, 'Unauthorized to delete this document', 403);
        }

        await docRef.delete();

        return successResponse(res, { id, collection, deleted: true });
      }

      default:
        return errorResponse(res, 'Method not allowed', 405);
    }
  } catch (error: any) {
    return errorResponse(
      res,
      error.message || 'Failed to process Firestore request',
      500
    );
  }
}
