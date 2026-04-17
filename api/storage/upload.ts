import type { VercelRequest, VercelResponse } from '../../lib/types';
import { storage, db, FieldValue } from '../../lib/firebase-admin';
import { handleCors, setCorsHeaders } from '../../lib/cors';
import { successResponse, errorResponse } from '../../lib/response';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  try {
    const userId = req.headers['x-user-id'] as string;
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

  } catch (error: any) {
    return errorResponse(res, error.message || 'Failed to generate upload URL', 500);
  }
}