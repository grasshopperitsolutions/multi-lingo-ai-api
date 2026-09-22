import type { VercelRequest, VercelResponse } from '../lib/types';
import { storage, db, FieldValue } from '../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { logInfo, logWarn, startTimer } from '../lib/logger';
import { reportError } from '../lib/sentry';

// Keys allowed inside the metadata object written to Firestore.
const ALLOWED_METADATA_KEYS = ['description', 'tags', 'altText', 'originalName'];

function sanitizeMetadata(raw: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => ALLOWED_METADATA_KEYS.includes(key))
  );
}

// Only these upload destinations are recognized — anything else is rejected
// rather than silently accepted as an arbitrary folder name.
const ALLOWED_UPLOAD_FOLDERS = new Set(['uploads', 'avatars']);

/**
 * Caps on the two client strings that end up inside a stored object's path.
 *
 * `fileName` is interpolated into `${folder}/${uid}/${Date.now()}_${fileName}`
 * and into the rename in PUT, and was previously checked only for being
 * non-empty. A write still cannot escape the caller's own `{folder}/{uid}/`
 * prefix — GCS object names are opaque strings, so `..` buys nothing — but an
 * unbounded one is a stored name nobody can list, search or delete by hand,
 * and this is the one endpoint that took client input of any length into
 * something persistent. ask-ai caps every field it accepts; so does this now.
 */
const MAX_FILE_NAME_LENGTH = 200;
const MAX_CONTENT_TYPE_LENGTH = 100;

/** Path separators and control characters have no business in a stored name. */
const UNSAFE_FILE_NAME = /[\x00-\x1f\x7f/\\]/;

/** Deliberately shape-only: `uploads` is general-purpose, unlike `avatars`. */
const CONTENT_TYPE_SHAPE = /^[\w.+-]+\/[\w.+-]+$/;

/**
 * Rejects a fileName/contentType pair, or returns null when both are fine.
 * Shared by POST and PUT so the two cannot drift apart.
 */
function rejectBadFileFields(fileName: unknown, contentType: unknown): string | null {
  if (fileName !== undefined) {
    if (typeof fileName !== 'string' || fileName.length === 0) {
      return 'fileName must be a non-empty string';
    }
    if (fileName.length > MAX_FILE_NAME_LENGTH) {
      return `fileName must be ${MAX_FILE_NAME_LENGTH} characters or fewer`;
    }
    if (UNSAFE_FILE_NAME.test(fileName)) {
      return 'fileName must not contain path separators or control characters';
    }
  }

  if (contentType !== undefined) {
    if (typeof contentType !== 'string' || contentType.length === 0) {
      return 'contentType must be a non-empty string';
    }
    if (contentType.length > MAX_CONTENT_TYPE_LENGTH) {
      return `contentType must be ${MAX_CONTENT_TYPE_LENGTH} characters or fewer`;
    }
    if (!CONTENT_TYPE_SHAPE.test(contentType)) {
      return 'contentType must look like type/subtype';
    }
  }

  return null;
}

// `avatars` uploads get a public-read ACL (see below), so unlike `uploads`
// they're restricted to actual image types.
const ALLOWED_AVATAR_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

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

        const invalid = rejectBadFileFields(fileName, contentType);
        if (invalid) return errorResponse(res, invalid, 400);

        if (!ALLOWED_UPLOAD_FOLDERS.has(folder)) {
          return errorResponse(
            res,
            `Invalid folder. Allowed: ${[...ALLOWED_UPLOAD_FOLDERS].join(', ')}`,
            400
          );
        }

        const isAvatar = folder === 'avatars';

        if (isAvatar && !ALLOWED_AVATAR_CONTENT_TYPES.has(contentType)) {
          return errorResponse(
            res,
            `Invalid contentType for an avatar upload. Allowed: ${[...ALLOWED_AVATAR_CONTENT_TYPES].join(', ')}`,
            400
          );
        }

        const bucket = storage.bucket();
        const filePath = `${folder}/${uid}/${Date.now()}_${fileName}`;
        const file = bucket.file(filePath);

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

        // Both are optional on a rename, so only what was actually sent is
        // checked — but a renamed object lands in a path the same way a new
        // one does, so it gets the same guard.
        const invalidUpdate = rejectBadFileFields(fileName, contentType);
        if (invalidUpdate) return errorResponse(res, invalidUpdate, 400);

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
          // Must be scoped to one of this caller's own upload folders — a
          // substring check (prefix.includes(uid)) previously accepted any
          // prefix that merely mentioned the uid anywhere in the string,
          // not just their own folder.
          const ownPrefixes = [...ALLOWED_UPLOAD_FOLDERS].map((f) => `${f}/${uid}/`);
          if (!ownPrefixes.some((p) => prefix.startsWith(p))) {
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
    await reportError('storage_unhandled_error', 'storage', error, {
      method: req.method,
      statusCode: 500,
      durationMs: elapsed(),
    });
    return errorResponse(res, 'Failed to process storage request', 500);
  }
}
