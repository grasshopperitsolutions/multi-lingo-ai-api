import type { VercelRequest, VercelResponse } from '../../lib/types';
import { db } from '../../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  if (req.method !== 'GET') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const { collection, id } = req.query;

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

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to read document', 500);
  }
}