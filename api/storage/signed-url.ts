import type { VercelRequest, VercelResponse } from '../../lib/types';
import { storage, db } from '../../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const userId = req.headers['x-user-id'] as string;
    const { fileId, expiresIn = 3600 } = req.body;

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
      return errorResponse(res, 'Unauthorized to access this file', 403);
    }

    // Generate signed URL
    const bucket = storage.bucket();
    const file = bucket.file(fileData.filePath);

    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + expiresIn * 1000
    });

    return successResponse(res, {
      signedUrl,
      fileId,
      fileName: fileData.fileName,
      contentType: fileData.contentType,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
    });

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to generate signed URL', 500);
  }
}