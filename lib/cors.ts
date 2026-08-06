// Falls back to FRONTEND_URL (already required for Stripe redirects) as the
// single default allowed origin when ALLOWED_ORIGINS isn't set, so a missing
// env var fails closed instead of reflecting every Origin header back with
// credentials enabled.
const configuredOrigins = process.env.ALLOWED_ORIGINS
  ?.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOrigins: string[] = configuredOrigins?.length
  ? configuredOrigins
  : process.env.FRONTEND_URL
    ? [process.env.FRONTEND_URL]
    : [];

export function setCorsHeaders(res: any) {
  const origin = res.req?.headers?.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  // Otherwise omit Access-Control-Allow-Origin entirely: browsers then
  // block the response for cross-origin callers on their own, and
  // non-browser callers (server-to-server, curl, Postman) never needed
  // CORS headers in the first place. Previously a missing/mismatched
  // Origin still got reflected back verbatim with credentials enabled —
  // the classic reflected-origin CORS misconfiguration.

  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );
}

export function handleCors(req: any, res: any): boolean {
  setCorsHeaders(res);

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200).end();
    return true;
  }

  return false;
}
