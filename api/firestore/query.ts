import type { VercelRequest, VercelResponse } from '../../lib/types';
import { db } from '../../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const { collection, filters = {}, orderBy = 'createdAt', order = 'desc', limit = 20, startAfter = null } = req.body;

    if (!collection) {
      return errorResponse(res, 'collection is required', 400);
    }

    let query: any = db.collection(collection);

    // Apply filters
    Object.entries(filters).forEach(([field, value]) => {
      query = query.where(field, '==', value);
    });

    // Apply ordering
    query = query.orderBy(orderBy, order);

    // Apply pagination
    const pageSize = Math.min(limit, 100);
    query = query.limit(pageSize);

    // Handle startAfter for pagination
    if (startAfter) {
      query = query.startAfter(startAfter);
    }

    const snapshot = await query.get();

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

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to query documents', 500);
  }
}