import type { VercelRequest, VercelResponse } from '../lib/types';
import { db, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  const userId = req.headers['x-user-id'] as string;

  try {
    switch (req.method) {
      case 'POST': {
        // Create document
        const { collection, data, id } = req.body;

        if (!collection || !data) {
          return errorResponse(res, 'collection and data are required', 400);
        }

        const documentData = {
          ...data,
          createdBy: userId,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        };

        let docRef;
        
        if (id) {
          docRef = db.collection(collection).doc(id);
          await docRef.set(documentData);
        } else {
          docRef = await db.collection(collection).add(documentData);
        }

        return successResponse(res, {
          id: docRef.id,
          collection
        }, 201);
      }

      case 'GET': {
        const { collection, id, query } = req.query;

        if (query) {
          // Query documents
          const filters = typeof query === 'string' ? JSON.parse(query) : query;
          const orderBy = (req.query.orderBy as string) || 'createdAt';
          const order = (req.query.order as string) || 'desc';
          const limit = parseInt(req.query.limit as string) || 20;
          const startAfter = req.query.startAfter;

          if (!collection) {
            return errorResponse(res, 'collection is required', 400);
          }

          let firestoreQuery: any = db.collection(collection as string);

          // Apply filters
          if (typeof filters === 'object') {
            Object.entries(filters).forEach(([field, value]) => {
              firestoreQuery = firestoreQuery.where(field, '==', value);
            });
          }

          // Apply ordering
          firestoreQuery = firestoreQuery.orderBy(orderBy, order);

          // Apply pagination
          const pageSize = Math.min(limit, 100);
          firestoreQuery = firestoreQuery.limit(pageSize);

          // Handle startAfter for pagination
          if (startAfter) {
            firestoreQuery = firestoreQuery.startAfter(startAfter);
          }

          const snapshot = await firestoreQuery.get();

          if (snapshot.empty) {
            return successResponse(res, {
              documents: [],
              collection,
              hasMore: false
            });
          }

          const documents = snapshot.docs.map((doc: any) => ({
            id: doc.id,
            ...doc.data()
          }));

          const lastVisible = snapshot.docs[snapshot.docs.length - 1];

          return successResponse(res, {
            documents,
            collection,
            hasMore: documents.length === pageSize,
            lastDocumentId: lastVisible ? lastVisible.id : null
          });
        } else {
          // Read single document
          if (!collection || !id) {
            return errorResponse(res, 'collection and id are required as query parameters', 400);
          }

          const docRef = db.collection(collection as string).doc(id as string);
          const doc = await docRef.get();

          if (!doc.exists) {
            return errorResponse(res, 'Document not found', 404);
          }

          return successResponse(res, {
            id: doc.id,
            data: doc.data(),
            collection
          });
        }
      }

      case 'PUT': {
        // Update document
        const { collection, id, data } = req.body;

        if (!collection || !id || !data) {
          return errorResponse(res, 'collection, id and data are required', 400);
        }

        // Users can only update their own profile document
        if (collection === 'users' && id !== userId) {
          return errorResponse(res, 'Unauthorized: you can only update your own profile', 403);
        }

        const docRef = db.collection(collection).doc(id);
        const doc = await docRef.get();

        if (!doc.exists) {
          return errorResponse(res, 'Document not found', 404);
        }

        // For non-user collections, check createdBy ownership
        if (collection !== 'users') {
          const docData = doc.data();
          if (docData && docData.createdBy && docData.createdBy !== userId) {
            return errorResponse(res, 'Unauthorized to update this document', 403);
          }
        }

        const updateData = {
          ...data,
          updatedBy: userId,
          updatedAt: FieldValue.serverTimestamp()
        };

        await docRef.update(updateData);

        return successResponse(res, {
          id,
          collection,
          updated: true
        });
      }

      case 'DELETE': {
        // Delete document
        const { collection, id } = req.body;

        if (!collection || !id) {
          return errorResponse(res, 'collection and id are required', 400);
        }

        const docRef = db.collection(collection).doc(id);
        const doc = await docRef.get();

        if (!doc.exists) {
          return errorResponse(res, 'Document not found', 404);
        }

        // Check ownership if document has createdBy field
        const docData = doc.data();
        if (docData && docData.createdBy && docData.createdBy !== userId) {
          return errorResponse(res, 'Unauthorized to delete this document', 403);
        }

        await docRef.delete();

        return successResponse(res, {
          id,
          collection,
          deleted: true
        });
      }

      default:
        return errorResponse(res, 'Method not allowed', 405);
    }

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to process Firestore request', 500);
  }
}
