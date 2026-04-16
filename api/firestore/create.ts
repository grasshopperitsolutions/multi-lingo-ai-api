import { VercelRequest, VercelResponse } from '@vercel/node';
import { db, FieldValue } from '../../lib/firebase-admin';
import { cors, runMiddleware } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await runMiddleware(req, res, cors);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const userId = req.headers['x-user-id'] as string;
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

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to create document', 500);
  }
}