import type { VercelRequest, VercelResponse } from '../lib/types';
import { db, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { logInfo, logWarn, logError, startTimer } from '../lib/logger';
import {
  parseCollectionPath,
  isUsersCollection,
  usersSubcollectionOwner,
  stripProtectedUserFields,
  authorizeUsersDocAccess,
  authorizeGenericDocWrite,
  authorizeGenericDocRead,
  authorizeUsersScopedRead,
} from '../lib/firestore-helpers';

/**
 * Resolves a slash-separated collection path to a Firestore CollectionReference.
 */
function resolveCollection(path: string): FirebaseFirestore.CollectionReference {
  const segments = parseCollectionPath(path);

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

/** Hard cap on query limit regardless of what the caller requests. */
const MAX_QUERY_LIMIT = 200;

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

        let segments: string[];
        try {
          segments = parseCollectionPath(collection);
        } catch (e: any) {
          return errorResponse(res, e.message, 400);
        }

        let sanitizedData = data;
        let existingData: Record<string, unknown> | undefined;

        if (id) {
          const existingSnap = await resolveDocument(collection, id).get();
          existingData = existingSnap.exists ? existingSnap.data() : undefined;
        }

        if (isUsersCollection(segments)) {
          if (!id) {
            return errorResponse(res, 'id is required when writing to the users collection', 400);
          }
          const authResult = await authorizeUsersDocAccess(id, uid, req, res);
          if (!authResult.ok) return;
          sanitizedData = stripProtectedUserFields(data, authResult.allowTierChange);
        } else {
          // Always consults the collection's write policy (e.g. admin-only
          // for appConfig/config/categories, even for a brand-new doc).
          // For the default (owner-or-admin) policy this is a no-op when
          // creating a fresh document — only overwriting one that already
          // exists is ownership-checked, closing the hole where POSTing a
          // known/guessed id let anyone hijack an existing document.
          const authorized = await authorizeGenericDocWrite(segments, existingData, uid, req, res);
          if (!authorized) return;
        }

        // Overwriting an existing doc merges onto it rather than replacing
        // it outright — a full replace would silently wipe any field the
        // caller didn't happen to include in this request.
        const documentData = {
          ...existingData,
          ...sanitizedData,
          createdBy: existingData?.createdBy ?? uid,
          createdAt: existingData?.createdAt ?? FieldValue.serverTimestamp(),
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

        // Every read requires a signed-in caller — this endpoint previously
        // allowed fully anonymous document reads and collection queries.
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        let segments: string[];
        try {
          segments = parseCollectionPath(collection as string);
        } catch (e: any) {
          return errorResponse(res, e.message, 400);
        }

        if (req.query.filters) {
          // Querying across the whole `users` collection (as opposed to
          // fetching one already-known uid below) means browsing/searching
          // everyone's profile data — restrict that to admins only. This is
          // the read path the admin Users panel uses to list every user.
          // Same restriction applies to querying someone else's
          // users/{uid}/... sub-collection.
          if (!(await authorizeUsersScopedRead(segments, undefined, uid, req, res))) return;

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
          const rawLimit = req.query.limit
            ? parseInt(req.query.limit as string, 10)
            : DEFAULT_QUERY_LIMIT;
          const limit = Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(rawLimit, MAX_QUERY_LIMIT)
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
              uid,
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
            uid,
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

        const isUsersScoped = isUsersCollection(segments) || usersSubcollectionOwner(segments) !== null;

        if (isUsersScoped) {
          if (!(await authorizeUsersScopedRead(segments, id as string, uid, req, res))) return;
        }

        const docRef = resolveDocument(
          collection as string,
          id as string
        );
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

        if (!isUsersScoped) {
          // Docs outside the users scope have no fixed ownership model —
          // authorize against whatever createdBy/userId this specific
          // document declares (see authorizeGenericDocRead). Previously any
          // authenticated caller could read any document here regardless
          // of who it actually belonged to.
          if (!(await authorizeGenericDocRead(segments, doc.data(), uid, req, res))) return;
        }

        logInfo('firestore_read', 'firestore', {
          uid,
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
      case 'PUT':
      case 'PATCH': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { collection, id, data } = req.body;

        if (!collection || !id || !data) {
          return errorResponse(res, 'collection, id and data are required', 400);
        }

        let segments: string[];
        try {
          segments = parseCollectionPath(collection);
        } catch (e: any) {
          return errorResponse(res, e.message, 400);
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

        let sanitizedData = data;
        const subOwner = usersSubcollectionOwner(segments);

        if (isUsersCollection(segments)) {
          // Editing your own doc is always allowed (protected fields get
          // stripped below). Editing someone else's doc — e.g. the admin
          // Users panel assigning a role — requires admin, and in that case
          // subscriptionTier is allowed through (still never Stripe/quota fields).
          const authResult = await authorizeUsersDocAccess(id, uid, req, res);
          if (!authResult.ok) return;
          sanitizedData = stripProtectedUserFields(data, authResult.allowTierChange);
        } else if (subOwner !== null) {
          // Anything nested under users/{targetUid}/... is owned by that
          // target user — previously this shape of path skipped every
          // ownership check entirely.
          const authResult = await authorizeUsersDocAccess(subOwner, uid, req, res);
          if (!authResult.ok) return;
        } else {
          // Generic top-level collection: ownership is read off createdBy
          // (set by this endpoint's own POST) or userId (set by
          // /api/storage). A document with neither field fails closed —
          // previously it silently passed the check.
          const authorized = await authorizeGenericDocWrite(segments, doc.data(), uid, req, res);
          if (!authorized) return;
        }

        const updateData = {
          ...sanitizedData,
          updatedBy: uid,
          updatedAt: FieldValue.serverTimestamp(),
        };

        await docRef.update(updateData);

        logInfo(req.method === 'PATCH' ? 'firestore_patch' : 'firestore_update', 'firestore', {
          uid,
          method: req.method,
          collection,
          docId: id,
          statusCode: 200,
          durationMs: elapsed(),
        });

        return successResponse(res, {
          id,
          collection,
          [req.method === 'PATCH' ? 'patched' : 'updated']: true,
        });
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

        let segments: string[];
        try {
          segments = parseCollectionPath(collection);
        } catch (e: any) {
          return errorResponse(res, e.message, 400);
        }

        if (isUsersCollection(segments)) {
          // A Firestore-only delete would orphan the Stripe subscription,
          // Storage files, and Firebase Auth record. Route through the
          // endpoint that cascades all of it (also admin-gated for
          // cross-user deletes there).
          return errorResponse(
            res,
            'User profile documents cannot be deleted directly. Use DELETE /api/auth to delete a user account.',
            400
          );
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

        const subOwner = usersSubcollectionOwner(segments);
        if (subOwner !== null) {
          const authResult = await authorizeUsersDocAccess(subOwner, uid, req, res);
          if (!authResult.ok) return;
        } else {
          const authorized = await authorizeGenericDocWrite(segments, doc.data(), uid, req, res);
          if (!authorized) return;
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
    return errorResponse(res, 'Failed to process Firestore request', 500);
  }
}
