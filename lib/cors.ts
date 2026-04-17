const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];

export function setCorsHeaders(res: any) {
  const origin = res.req?.headers?.origin || '*';
  
  if (allowedOrigins.includes(origin) || !process.env.ALLOWED_ORIGINS) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0] || '*');
  }
  
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
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