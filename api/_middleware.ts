import { NextRequest, NextResponse } from 'next/server';
import { auth } from '../lib/firebase-admin';

const PUBLIC_ROUTES = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/google',
  '/api/auth/apple',
  '/api/auth/facebook',
  '/api/auth/twitter',
  '/api/auth/refresh-token',
  '/api/auth/verify-email',
  '/api/auth/reset-password'
];

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  
  // Allow public routes without authentication
  if (PUBLIC_ROUTES.some(route => path.startsWith(route))) {
    return NextResponse.next();
  }

  // Handle OPTIONS preflight requests
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 200 });
  }

  // Verify Authorization header
  const authHeader = request.headers.get('authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    
    // Attach user data to request headers for downstream use
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-user-id', decodedToken.uid);
    requestHeaders.set('x-user-email', decodedToken.email || '');

    return NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
  } catch (error) {
    return new NextResponse(JSON.stringify({ error: 'Invalid or expired token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}