import { auth } from './firebase-admin';
import type { VercelRequest, VercelResponse } from './types';

/**
 * Verifies the Bearer token in the Authorization header.
 * On success returns the decoded uid.
 * On failure writes a 401 response and returns null.
 */
export const verifyAuth = async (
  req: VercelRequest,
  res: VercelResponse
): Promise<string | null> => {
  const authHeader = req.headers['authorization'] as string | undefined;

  if (!authHeader?.startsWith('Bearer ')) {
    res.writeHead(401).json({ error: 'Authorization header is required' });
    return null;
  }

  const token = authHeader.split('Bearer ')[1];

  if (!token) {
    res.writeHead(401).json({ error: 'Bearer token is required' });
    return null;
  }

  try {
    const decoded = await auth.verifyIdToken(token);
    return decoded.uid;
  } catch (error: any) {
    res.writeHead(401).json({ error: error.message || 'Invalid or expired token' });
    return null;
  }
};
