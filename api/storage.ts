import type { VercelRequest, VercelResponse } from '../lib/types';
import { storage, db, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';

// Keys allowed inside the metadata object written to Firestore.
// Never spread raw client input — a caller could inject userId, status, etc.
const ALLOWED_METADATA_KEYS = ['description', 'tags', 'altText', 'originalName'];

function sanitizeMetadata(raw: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => ALLOWED_METADATA_KEYS.includes(key))
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);

  if (handleCors(req, res)) return;

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

        // Build signed URL options.
        // For avatars: include x-goog-acl: public-read so the browser PUT
        // sets the object ACL to public at upload time. This makes publicUrl
        // directly usable in <img> tags without any auth.
        const signedUrlOptions: Parameters<typeof file.getSignedUrl>[0] = {
          action: 'write',
          expires: Date.now() + 15 * 60 * 1000, // 15 minutes
          contentType,
          ...(isAvatar && {
            extensionHeaders: { 'x-goog-acl': 'public-read' },
          }),
        };

        const [uploadUrl] = await file.getSignedUrl(signedUrlOptions);

        // Avatars are tracked on the users doc via photoURL — no files doc needed.
        // For all other folders, create a files doc to track the upload.
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
          return errorResponse(res, 'File not found', 404);
        }

        const fileData = fileDoc.data();

        if (fileData?.userId !== uid) {
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

        return successResponse(res, {
          fileId,
          filePath: newFilePath,
          publicUrl: `https://storage.googleapis.com/${bucket.name}/${newFilePath}`,
        });
      }

      case 'DELETE': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { fileId, filePath } = req.body;

        // --- Avatar deletion path (no fileId, use filePath directly) ---
        // Avatars are not tracked in the files collection, so they must be
        // deleted by their GCS path. We enforce that the path belongs to
        // the authenticated user to prevent deleting other users' files.
        if (filePath && !fileId) {
          const allowedPrefix = `avatars/${uid}/`;
          if (!filePath.startsWith(allowedPrefix)) {
            return errorResponse(res, 'Unauthorized to delete this file', 403);
          }
          const bucket = storage.bucket();
          const file = bucket.file(filePath as string);
          try {
            await file.delete();
          } catch (e: any) {
            // File may already be gone — treat as success
            if (e.code !== 404 && e.code !== 'NOT_FOUND') throw e;
          }
          return successResponse(res, { message: 'File deleted successfully', filePath });
        }

        // --- Standard fileId-based deletion path ---
        if (!fileId) {
          return errorResponse(res, 'fileId is required', 400);
        }

        const fileDoc = await db.collection('files').doc(fileId as string).get();

        if (!fileDoc.exists) {
          return errorResponse(res, 'File not found', 404);
        }

        const fileData = fileDoc.data();

        if (fileData?.userId !== uid) {
          return errorResponse(res, 'Unauthorized to delete this file', 403);
        }

        const bucket = storage.bucket();
        const file = bucket.file(fileData.filePath);
        await file.delete();

        await fileDoc.ref.delete();

        return successResponse(res, {
          message: 'File deleted successfully',
          fileId,
        });
      }

      case 'GET': {
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const { fileId } = req.query;
        // req.query values are always strings — parseInt prevents NaN from
        // the previous `(expiresIn as number) * 1000` cast.
        const expiresIn = parseInt(req.query.expiresIn as string, 10) || 3600;

        if (!fileId) {
          return errorResponse(res, 'fileId is required', 400);
        }

        const fileDoc = await db.collection('files').doc(fileId as string).get();

        if (!fileDoc.exists) {
          return errorResponse(res, 'File not found', 404);
        }

        const fileData = fileDoc.data();

        if (fileData?.userId !== uid) {
          return errorResponse(res, 'Unauthorized to access this file', 403);
        }

        const bucket = storage.bucket();
        const file = bucket.file(fileData.filePath);

        const [signedUrl] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + expiresIn * 1000,
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
    return errorResponse(res, error.message || 'Failed to process storage request', 500);
  }
}
