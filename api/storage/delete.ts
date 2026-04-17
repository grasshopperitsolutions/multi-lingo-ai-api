import type { VercelRequest, VercelResponse } from '../../lib/types';
import { storage, db } from '../../lib/firebase-admin';
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
    const { fileId } = req.body;

    if (!fileId) {
      return errorResponse(res, 'fileId is required', 400);
    }

    // Get file record
    const fileDoc = await db.collection('files').doc(fileId).get();

    if (!fileDoc.exists) {
      return errorResponse(res, 'File not found', 404);
    }

    const fileData = fileDoc.data();

    // Check ownership
    if (fileData?.userId !== userId) {
      return errorResponse(res, 'Unauthorized to delete this file', 403);
    }

    // Delete file from Storage
    const bucket = storage.bucket();
    const file = bucket.file(fileData.filePath);
    await file.delete();

    // Delete file record from Firestore
    await fileDoc.ref.delete();

    return successResponse(res, {
      message: 'File deleted successfully',
      fileId
    });

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to delete file', 500);
  }
}