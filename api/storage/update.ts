import type { VercelRequest, VercelResponse } from '../../lib/types';
import { storage, db, FieldValue } from '../../lib/firebase-admin';
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
    const { fileId, fileName, contentType, metadata } = req.body;

    if (!fileId) {
      return errorResponse(res, 'fileId is required', 400);
    }

    // Get current file record
    const fileDoc = await db.collection('files').doc(fileId).get();

    if (!fileDoc.exists) {
      return errorResponse(res, 'File not found', 404);
    }

    const fileData = fileDoc.data();

    // Check ownership
    if (fileData?.userId !== userId) {
      return errorResponse(res, 'Unauthorized to update this file', 403);
    }

    const bucket = storage.bucket();
    const oldFilePath = fileData.filePath;
    const newFilePath = oldFilePath.replace(/\/[^\/]+$/, `/${Date.now()}_${fileName || fileData.fileName}`);

    // If file content is being replaced, copy to new path and delete old
    if (fileName) {
      const oldFile = bucket.file(oldFilePath);
      const newFile = bucket.file(newFilePath);

      await oldFile.copy(newFile);
      await oldFile.delete();

      // Update Firestore record
      await fileDoc.ref.update({
        fileName: fileName || fileData.fileName,
        contentType: contentType || fileData.contentType,
        filePath: newFilePath,
        metadata: metadata ? { ...fileData.metadata, ...metadata } : fileData.metadata,
        updatedAt: FieldValue.serverTimestamp(),
        status: 'completed'
      });
    } else if (metadata) {
      // Only update metadata
      await fileDoc.ref.update({
        metadata: { ...fileData.metadata, ...metadata },
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    return successResponse(res, {
      fileId,
      filePath: newFilePath,
      publicUrl: `https://storage.googleapis.com/${bucket.name}/${newFilePath}`
    });

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to update file', 500);
  }
}