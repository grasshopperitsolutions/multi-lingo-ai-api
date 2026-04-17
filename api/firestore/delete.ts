import type { VercelRequest, VercelResponse } from '../../lib/types';
import { db } from '../../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  if (req.method !== 'DELETE') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const userId = req.headers['x-user-id'] as string;
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

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to delete document', 500);
  }
}