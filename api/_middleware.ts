import { auth } from '../lib/firebase-admin';
import { setCorsHeaders } from '../lib/cors';
import type { VercelRequest, VercelResponse } from '../lib/types';

// Public endpoints that don't require authentication
const publicPaths = [
  '/api/auth'
];

export default async function middleware(req: VercelRequest, res: VercelResponse, next: () => void) {
  setCorsHeaders(res);

  // Skip authentication for OPTIONS requests and public endpoints
  if (req.method === 'OPTIONS') {
    res.writeHead(200).end();
    return;
  }

  const url = req.url || '';
  if (publicPaths.some(path => url.startsWith(path))) {
    next();
    return;
  }

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.writeHead(401).json({ error: 'Authorization header is required' });
      return;
    }

    const token = authHeader.split('Bearer ')[1];

    if (!token) {
      res.writeHead(401).json({ error: 'Bearer token is required' });
      return;
    }

    const decodedToken = await auth.verifyIdToken(token);

    // Add user ID to request headers
    req.headers['x-user-id'] = decodedToken.uid;

    next();
  } catch (error: any) {
    res.writeHead(401).json({ error: error.message || 'Invalid or expired token' });
  }
}