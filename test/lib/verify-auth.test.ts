import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockReqRes } from '../helpers/httpMocks';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils } from '../helpers/mockFirebaseAdmin';
import { verifyAuth } from '../../lib/verify-auth';

beforeEach(() => {
  __testUtils.reset();
});

describe('verifyAuth', () => {
  it('returns the uid for a valid bearer token', async () => {
    __testUtils.setValidToken('good-token', { uid: 'alice' });
    const { req, res } = createMockReqRes({ headers: { authorization: 'Bearer good-token' } });
    const uid = await verifyAuth(req, res);
    expect(uid).toBe('alice');
    expect(res.statusCode).toBe(200);
  });

  it('rejects a missing Authorization header with 401', async () => {
    const { req, res } = createMockReqRes();
    const uid = await verifyAuth(req, res);
    expect(uid).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-Bearer Authorization header with 401', async () => {
    const { req, res } = createMockReqRes({ headers: { authorization: 'Basic abc123' } });
    const uid = await verifyAuth(req, res);
    expect(uid).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid/expired token with 401', async () => {
    const { req, res } = createMockReqRes({ headers: { authorization: 'Bearer not-a-real-token' } });
    const uid = await verifyAuth(req, res);
    expect(uid).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
  });
});
