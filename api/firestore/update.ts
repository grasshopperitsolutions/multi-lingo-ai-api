import type { VercelRequest, VercelResponse } from '../../lib/types';
import { db, FieldValue } from '../../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  if (req.method !== 'PUT') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const userId = req.headers['x-user-id'] as string;
    const { collection, id, data } = req.body;

    if (!collection || !id || !data) {
      return errorResponse(res, 'collection, id and data are required', 400);
    }

    const docRef = db.collection(collection).doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return errorResponse(res, 'Document not found', 404);
    }

    // Check ownership if document has createdBy field
    const docData = doc.data();
    if (docData && docData.createdBy && docData.createdBy !== userId) {
      return errorResponse(res, 'Unauthorized to update this document', 403);
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

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to update document', 500);
  }
}