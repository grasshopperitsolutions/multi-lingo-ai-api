import type { VercelRequest, VercelResponse } from '../lib/types';
import { storage, db, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { logInfo, logWarn, logError, startTimer } from '../lib/logger';

// Keys allowed inside the metadata object written to Firestore.
const ALLOWED_METADATA_KEYS = ['description', 'tags', 'altText', 'originalName'];

function sanitizeMetadata(raw: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => ALLOWED_METADATA_KEYS.includes(key))
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);

  if (handleCors(req, res)) return;

  const elapsed = startTimer();

  try {
    switch (req.method) {
      case 'POST': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { fileName, contentType, folder = 'uploads', metadata = {} } = req.body;

        if (!fileName || !contentType) {
          return errorResponse(res, 'fileName and contentType are required', 400);
        }

        const bucket = storage.bucket();
        const filePath = `${folder}/${uid}/${Date.now()}_${fileName}`;
        const file = bucket.file(filePath);
        const isAvatar = folder === 'avatars';

        const signedUrlOptions: Parameters<typeof file.getSignedUrl>[0] = {
          action: 'write',
          expires: Date.now() + 15 * 60 * 1000,
          contentType,
          ...(isAvatar && {
            extensionHeaders: { 'x-goog-acl': 'public-read' },
          }),
        };

        const [uploadUrl] = await file.getSignedUrl(signedUrlOptions);

        let fileId: string | null = null;
        if (!isAvatar) {
          const fileRef = await db.collection('files').add({
            userId: uid,
            fileName,
            contentType,
            filePath,
            folder,
            metadata: sanitizeMetadata(metadata),
            status: 'pending',
            createdAt: FieldValue.serverTimestamp(),
          });
          fileId = fileRef.id;
        }

        logInfo('storage_upload_initiated', 'storage', {
          uid,
          method: req.method,
          folder,
          fileName,
          contentType,
          isAvatar,
          fileId,
          statusCode: 200,
          durationMs: elapsed(),
        });

        return successResponse(res, {
          fileId,
          uploadUrl,
          filePath,
          publicUrl: `https://storage.googleapis.com/${bucket.name}/${filePath}`,
        });
      }

      case 'PUT': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { fileId, fileName, contentType, metadata } = req.body;

        if (!fileId) {
          return errorResponse(res, 'fileId is required', 400);
        }

        const fileDoc = await db.collection('files').doc(fileId).get();

        if (!fileDoc.exists) {
          logWarn('storage_file_not_found', 'storage', {
            uid,
            method: req.method,
            fileId,
            statusCode: 404,
            durationMs: elapsed(),
          });
          return errorResponse(res, 'File not found', 404);
        }

        const fileData = fileDoc.data();

        if (fileData?.userId !== uid) {
          logWarn('storage_auth_denied', 'storage', {
            uid,
            method: req.method,
            fileId,
            statusCode: 403,
            durationMs: elapsed(),
          });
          return errorResponse(res, 'Unauthorized to update this file', 403);
        }

        const bucket = storage.bucket();
        const oldFilePath = fileData.filePath;
        const newFilePath = oldFilePath.replace(/\/[^\/]+$/, `/${Date.now()}_${fileName || fileData.fileName}`);

        if (fileName) {
          const oldFile = bucket.file(oldFilePath);
          const newFile = bucket.file(newFilePath);

          await oldFile.copy(newFile);
          await oldFile.delete();

          await fileDoc.ref.update({
            fileName: fileName || fileData.fileName,
            contentType: contentType || fileData.contentType,
            filePath: newFilePath,
            metadata: metadata
              ? { ...fileData.metadata, ...sanitizeMetadata(metadata) }
              : fileData.metadata,
            updatedAt: FieldValue.serverTimestamp(),
            status: 'completed',
          });
        } else if (metadata) {
          await fileDoc.ref.update({
            metadata: { ...fileData.metadata, ...sanitizeMetadata(metadata) },
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        logInfo('storage_file_updated', 'storage', {
          uid,
          method: req.method,
          fileId,
          renamed: !!fileName,
          metadataOnly: !fileName && !!metadata,
          statusCode: 200,
          durationMs: elapsed(),
        });

        return successResponse(res, {
          fileId,
          filePath: newFilePath,
          publicUrl: `https://storage.googleapis.com/${bucket.name}/${newFilePath}`,
        });
      }

      case 'DELETE': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { fileId, prefix } = req.body;

        if (prefix && !fileId) {
          if (!prefix.includes(uid)) {
            logWarn('storage_auth_denied', 'storage', {
              uid,
              method: req.method,
              prefix,
              statusCode: 403,
              durationMs: elapsed(),
            });
            return errorResponse(res, 'Unauthorized to delete this prefix', 403);
          }
          const bucket = storage.bucket();
          try {
            await bucket.deleteFiles({ prefix, force: true });
          } catch (e: any) {
            if (e.code !== 404 && e.code !== 'NOT_FOUND') throw e;
          }

          logInfo('storage_bulk_delete', 'storage', {
            uid,
            method: req.method,
            prefix,
            statusCode: 200,
            durationMs: elapsed(),
          });

          return successResponse(res, { message: 'Files deleted successfully', prefix });
        }

        if (!fileId) {
          return errorResponse(res, 'fileId or prefix is required', 400);
        }

        const fileDoc = await db.collection('files').doc(fileId as string).get();

        if (!fileDoc.exists) {
          logWarn('storage_file_not_found', 'storage', {
            uid,
            method: req.method,
            fileId,
            statusCode: 404,
            durationMs: elapsed(),
          });
          return errorResponse(res, 'File not found', 404);
        }

        const fileData = fileDoc.data();

        if (fileData?.userId !== uid) {
          logWarn('storage_auth_denied', 'storage', {
            uid,
            method: req.method,
            fileId,
            statusCode: 403,
            durationMs: elapsed(),
          });
          return errorResponse(res, 'Unauthorized to delete this file', 403);
        }

        const bucket = storage.bucket();
        const file = bucket.file(fileData.filePath);
        await file.delete();

        await fileDoc.ref.delete();

        logInfo('storage_file_deleted', 'storage', {
          uid,
          method: req.method,
          fileId,
          statusCode: 200,
          durationMs: elapsed(),
        });

        return successResponse(res, {
          message: 'File deleted successfully',
          fileId,
        });
      }

      case 'GET': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { fileId } = req.query;
        const expiresIn = parseInt(req.query.expiresIn as string, 10) || 3600;

        if (!fileId) {
          return errorResponse(res, 'fileId is required', 400);
        }

        const fileDoc = await db.collection('files').doc(fileId as string).get();

        if (!fileDoc.exists) {
          logWarn('storage_file_not_found', 'storage', {
            uid,
            method: req.method,
            fileId,
            statusCode: 404,
            durationMs: elapsed(),
          });
          return errorResponse(res, 'File not found', 404);
        }

        const fileData = fileDoc.data();

        if (fileData?.userId !== uid) {
          logWarn('storage_auth_denied', 'storage', {
            uid,
            method: req.method,
            fileId,
            statusCode: 403,
            durationMs: elapsed(),
          });
          return errorResponse(res, 'Unauthorized to access this file', 403);
        }

        const bucket = storage.bucket();
        const file = bucket.file(fileData.filePath);

        const [signedUrl] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + expiresIn * 1000,
        });

        logInfo('storage_signed_url_generated', 'storage', {
          uid,
          method: req.method,
          fileId,
          expiresIn,
          statusCode: 200,
          durationMs: elapsed(),
        });

        return successResponse(res, {
          signedUrl,
          fileId,
          fileName: fileData.fileName,
          contentType: fileData.contentType,
          expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        });
      }

      default:
        return errorResponse(res, 'Method not allowed', 405);
    }

  } catch (error: any) {
    logError('storage_unhandled_error', 'storage', {
      method: req.method,
      statusCode: 500,
      durationMs: elapsed(),
      errorMessage: error?.message,
    });
    return errorResponse(res, error.message || 'Failed to process storage request', 500);
  }
}
