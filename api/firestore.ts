import type { VercelRequest, VercelResponse } from '../lib/types';
import { db, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { logInfo, logWarn, logError, startTimer } from '../lib/logger';

/**
 * Resolves a slash-separated collection path to a Firestore CollectionReference.
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

  if (segments.length === 1) {
    return db.collection(segments[0]);
  }

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
 */
function resolveDocument(
  collectionPath: string,
  docId: string
): FirebaseFirestore.DocumentReference {
  return resolveCollection(collectionPath).doc(docId);
}

/**
 * Supported Firestore WhereFilterOp values.
 */
const ALLOWED_OPS = new Set([
  '==', '!=', '<', '<=', '>', '>=',
  'array-contains', 'in', 'not-in', 'array-contains-any',
]);

/** Default query limit when the caller does not specify one. */
const DEFAULT_QUERY_LIMIT = 100;

/**
 * Fields on the `users` collection that are only ever set by server-side
 * logic (the Stripe webhook handler, the ask-ai quota counter) — never
 * accepted from a client-authored PUT/PATCH, even on the caller's own doc.
 */
const PROTECTED_USER_FIELDS = [
  'subscriptionTier',
  'subscriptionStatus',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'currentPeriodEnd',
  'aiCallsToday',
  'aiCallsDate',
];

function stripProtectedUserFields(data: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...data };
  for (const field of PROTECTED_USER_FIELDS) {
    delete cleaned[field];
  }
  return cleaned;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);

  if (handleCors(req, res)) return;

  const elapsed = startTimer();

  try {
    switch (req.method) {
      // ─────────────────────────────────────────────────────────────────────
      // POST — create a document
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

        logInfo('firestore_write', 'firestore', {
          uid,
          method: req.method,
          collection,
          docId: docRef.id,
          statusCode: 201,
          durationMs: elapsed(),
        });

        return successResponse(res, { id: docRef.id, collection }, 201);
      }

      // ─────────────────────────────────────────────────────────────────────
      // GET — fetch a single document OR run a filtered query
      // ─────────────────────────────────────────────────────────────────────
      case 'GET': {
        const { collection, id } = req.query;

        if (!collection) {
          return errorResponse(res, 'collection is required', 400);
        }

        if (req.query.filters) {
          let filters: Array<{ field: string; op: string; value: unknown }>;

          try {
            filters = typeof req.query.filters === 'string'
              ? JSON.parse(req.query.filters)
              : req.query.filters;
          } catch {
            return errorResponse(res, 'filters must be a valid JSON array', 400);
          }

          if (!Array.isArray(filters)) {
            return errorResponse(res, 'filters must be an array of { field, op, value } objects', 400);
          }

          const orderBy = req.query.orderBy as string | undefined;
          const order = (req.query.order as 'asc' | 'desc') || undefined;
          const limit = req.query.limit
            ? parseInt(req.query.limit as string, 10)
            : DEFAULT_QUERY_LIMIT;
          const startAfter = req.query.startAfter;

          let firestoreQuery: FirebaseFirestore.Query = resolveCollection(
            collection as string
          );

          for (const filter of filters) {
            const { field, op, value } = filter;

            if (!field || !op) {
              return errorResponse(res, 'Each filter must have field and op', 400);
            }
            if (!ALLOWED_OPS.has(op)) {
              return errorResponse(res, `Unsupported filter operator: "${op}". Allowed: ${[...ALLOWED_OPS].join(', ')}`, 400);
            }

            firestoreQuery = firestoreQuery.where(
              field,
              op as FirebaseFirestore.WhereFilterOp,
              value
            );
          }

          if (orderBy) {
            firestoreQuery = firestoreQuery.orderBy(orderBy, order);
          }

          firestoreQuery = firestoreQuery.limit(limit);

          if (startAfter && orderBy) {
            firestoreQuery = firestoreQuery.startAfter(startAfter);
          }

          const snapshot = await firestoreQuery.get();

          if (snapshot.empty) {
            logInfo('firestore_query', 'firestore', {
              method: req.method,
              collection,
              filterCount: filters.length,
              resultCount: 0,
              statusCode: 200,
              durationMs: elapsed(),
            });
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

          logInfo('firestore_query', 'firestore', {
            method: req.method,
            collection,
            filterCount: filters.length,
            resultCount: documents.length,
            hasMore: documents.length === limit,
            statusCode: 200,
            durationMs: elapsed(),
          });

          return successResponse(res, {
            documents,
            collection,
            hasMore: documents.length === limit,
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
          logWarn('firestore_doc_not_found', 'firestore', {
            method: req.method,
            collection,
            docId: id,
            statusCode: 404,
            durationMs: elapsed(),
          });
          return errorResponse(res, 'Document not found', 404);
        }

        logInfo('firestore_read', 'firestore', {
          method: req.method,
          collection,
          docId: id,
          statusCode: 200,
          durationMs: elapsed(),
        });

        return successResponse(res, {
          id: doc.id,
          data: doc.data(),
          collection,
        });
      }

      // ─────────────────────────────────────────────────────────────────────
      // PUT — partial update
      // ─────────────────────────────────────────────────────────────────────
      case 'PUT': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { collection, id, data } = req.body;

        if (!collection || !id || !data) {
          return errorResponse(res, 'collection, id and data are required', 400);
        }

        const docRef = resolveDocument(collection, id);
        const doc = await docRef.get();

        if (!doc.exists) {
          logWarn('firestore_doc_not_found', 'firestore', {
            uid,
            method: req.method,
            collection,
            docId: id,
            statusCode: 404,
            durationMs: elapsed(),
          });
          return errorResponse(res, 'Document not found', 404);
        }

        const isTopLevel = !collection.includes('/');
        let sanitizedData = data;

        if (isTopLevel && collection === 'users') {
          if (id !== uid) {
            logWarn('firestore_auth_denied', 'firestore', {
              uid,
              method: req.method,
              collection,
              docId: id,
              statusCode: 403,
              durationMs: elapsed(),
            });
            return errorResponse(res, 'Unauthorized to update this document', 403);
          }
          sanitizedData = stripProtectedUserFields(data);
        } else if (isTopLevel) {
          const docData = doc.data();
          if (docData?.createdBy && docData.createdBy !== uid) {
            logWarn('firestore_auth_denied', 'firestore', {
              uid,
              method: req.method,
              collection,
              docId: id,
              statusCode: 403,
              durationMs: elapsed(),
            });
            return errorResponse(res, 'Unauthorized to update this document', 403);
          }
        }

        const updateData = {
          ...sanitizedData,
          updatedBy: uid,
          updatedAt: FieldValue.serverTimestamp(),
        };

        await docRef.update(updateData);

        logInfo('firestore_update', 'firestore', {
          uid,
          method: req.method,
          collection,
          docId: id,
          statusCode: 200,
          durationMs: elapsed(),
        });

        return successResponse(res, { id, collection, updated: true });
      }

      // ─────────────────────────────────────────────────────────────────────
      // PATCH — deep merge update
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
          logWarn('firestore_doc_not_found', 'firestore', {
            uid,
            method: req.method,
            collection,
            docId: id,
            statusCode: 404,
            durationMs: elapsed(),
          });
          return errorResponse(res, 'Document not found', 404);
        }

        const isTopLevelPatch = !collection.includes('/');
        let sanitizedPatchData = data;

        if (isTopLevelPatch && collection === 'users') {
          if (id !== uid) {
            logWarn('firestore_auth_denied', 'firestore', {
              uid,
              method: req.method,
              collection,
              docId: id,
              statusCode: 403,
              durationMs: elapsed(),
            });
            return errorResponse(res, 'Unauthorized to update this document', 403);
          }
          sanitizedPatchData = stripProtectedUserFields(data);
        }

        const patchData = {
          ...sanitizedPatchData,
          updatedBy: uid,
          updatedAt: FieldValue.serverTimestamp(),
        };

        await docRef.update(patchData);

        logInfo('firestore_patch', 'firestore', {
          uid,
          method: req.method,
          collection,
          docId: id,
          statusCode: 200,
          durationMs: elapsed(),
        });

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
          logWarn('firestore_doc_not_found', 'firestore', {
            uid,
            method: req.method,
            collection,
            docId: id,
            statusCode: 404,
            durationMs: elapsed(),
          });
          return errorResponse(res, 'Document not found', 404);
        }

        const docData = doc.data();
        if (docData?.createdBy && docData.createdBy !== uid) {
          logWarn('firestore_auth_denied', 'firestore', {
            uid,
            method: req.method,
            collection,
            docId: id,
            statusCode: 403,
            durationMs: elapsed(),
          });
          return errorResponse(res, 'Unauthorized to delete this document', 403);
        }

        await docRef.delete();

        logInfo('firestore_delete', 'firestore', {
          uid,
          method: req.method,
          collection,
          docId: id,
          statusCode: 200,
          durationMs: elapsed(),
        });

        return successResponse(res, { id, collection, deleted: true });
      }

      default:
        return errorResponse(res, 'Method not allowed', 405);
    }
  } catch (error: any) {
    logError('firestore_unhandled_error', 'firestore', {
      method: req.method,
      statusCode: 500,
      durationMs: elapsed(),
      errorMessage: error?.message,
    });
    return errorResponse(
      res,
      error.message || 'Failed to process Firestore request',
      500
    );
  }
}
