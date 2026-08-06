import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockReqRes } from '../helpers/httpMocks';

const ENV_KEYS = ['ALLOWED_ORIGINS', 'FRONTEND_URL'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key]!;
  }
});

/** lib/cors.ts computes its allow-list at module load, so each scenario needs a fresh import. */
async function loadCors() {
  vi.resetModules();
  return import('../../lib/cors');
}

describe('setCorsHeaders', () => {
  it('reflects an origin that is in the configured ALLOWED_ORIGINS list, with credentials', async () => {
    process.env.ALLOWED_ORIGINS = 'https://a.example.com, https://b.example.com';
    const { setCorsHeaders } = await loadCors();
    const { res } = createMockReqRes({ headers: { origin: 'https://b.example.com' } });
    setCorsHeaders(res);
    expect(res.headers['access-control-allow-origin']).toBe('https://b.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('omits Access-Control-Allow-Origin for an origin not in the allow-list — no reflection', async () => {
    process.env.ALLOWED_ORIGINS = 'https://a.example.com';
    const { setCorsHeaders } = await loadCors();
    const { res } = createMockReqRes({ headers: { origin: 'https://evil.example.com' } });
    setCorsHeaders(res);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('falls back to FRONTEND_URL as the only allowed origin when ALLOWED_ORIGINS is unset', async () => {
    delete process.env.ALLOWED_ORIGINS;
    process.env.FRONTEND_URL = 'https://app.example.com';
    const { setCorsHeaders } = await loadCors();

    const { res: allowed } = createMockReqRes({ headers: { origin: 'https://app.example.com' } });
    setCorsHeaders(allowed);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');

    const { res: blocked } = createMockReqRes({ headers: { origin: 'https://random-site.example.com' } });
    setCorsHeaders(blocked);
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not reflect an arbitrary origin when neither ALLOWED_ORIGINS nor FRONTEND_URL is set — fails closed (finding 2.1)', async () => {
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.FRONTEND_URL;
    const { setCorsHeaders } = await loadCors();
    const { res } = createMockReqRes({ headers: { origin: 'https://anything.example.com' } });
    setCorsHeaders(res);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('always sets the allowed methods and headers regardless of origin', async () => {
    delete process.env.ALLOWED_ORIGINS;
    process.env.FRONTEND_URL = 'https://app.example.com';
    const { setCorsHeaders } = await loadCors();
    const { res } = createMockReqRes();
    setCorsHeaders(res);
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });
});

describe('handleCors', () => {
  it('short-circuits OPTIONS preflight requests with a 200', async () => {
    process.env.FRONTEND_URL = 'https://app.example.com';
    const { handleCors } = await loadCors();
    const { req, res } = createMockReqRes({ method: 'OPTIONS' });
    const handled = handleCors(req, res);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('returns false for non-OPTIONS methods, letting the caller continue', async () => {
    process.env.FRONTEND_URL = 'https://app.example.com';
    const { handleCors } = await loadCors();
    const { req, res } = createMockReqRes({ method: 'GET' });
    expect(handleCors(req, res)).toBe(false);
  });
});
