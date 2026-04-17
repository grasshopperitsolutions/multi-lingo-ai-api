import type { VercelRequest, VercelResponse } from '../lib/types';
import { storage, db, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  const userId = req.headers['x-user-id'] as string;

  try {
    switch (req.method) {
      case 'POST': {
        // Upload (generate signed URL)
        const { fileName, contentType, folder = 'uploads', metadata = {} } = req.body;

        if (!fileName || !contentType) {
          return errorResponse(res, 'fileName and contentType are required', 400);
        }

        const bucket = storage.bucket();
        const filePath = `${folder}/${userId}/${Date.now()}_${fileName}`;
        const file = bucket.file(filePath);

        // Generate signed upload URL
        const [uploadUrl] = await file.getSignedUrl({
          action: 'write',
          expires: Date.now() + 15 * 60 * 1000,
          contentType: contentType
        });

        // Store file reference in Firestore
        const fileRef = await db.collection('files').add({
          userId,
          fileName,
          contentType,
          filePath,
          folder,
          metadata,
          status: 'pending',
          createdAt: FieldValue.serverTimestamp()
        });

        return successResponse(res, {
          fileId: fileRef.id,
          uploadUrl,
          filePath,
          publicUrl: `https://storage.googleapis.com/${bucket.name}/${filePath}`
        });
      }

      case 'PUT': {
        // Update file metadata
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
      }

      case 'DELETE': {
        // Delete file
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
      }

      case 'GET': {
        // Get signed URL for download
        const { fileId, expiresIn = 3600 } = req.query;

        if (!fileId) {
          return errorResponse(res, 'fileId is required', 400);
        }

        // Get file record
        const fileDoc = await db.collection('files').doc(fileId as string).get();

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
          expires: Date.now() + (expiresIn as number) * 1000
        });

        return successResponse(res, {
          signedUrl,
          fileId,
          fileName: fileData.fileName,
          contentType: fileData.contentType,
          expiresAt: new Date(Date.now() + (expiresIn as number) * 1000).toISOString()
        });
      }

      default:
        return errorResponse(res, 'Method not allowed', 405);
    }

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to process storage request', 500);
  }
}