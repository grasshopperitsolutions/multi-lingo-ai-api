import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockReqRes } from '../helpers/httpMocks';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils } from '../helpers/mockFirebaseAdmin';
import { verifyAuth, verifyAuthSession } from '../../lib/verify-auth';

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

describe('verifyAuthSession', () => {
  it('reports a normal sign-in as not anonymous', async () => {
    __testUtils.setValidToken('good-token', { uid: 'alice', firebase: { sign_in_provider: 'google.com' } });
    const { req, res } = createMockReqRes({ headers: { authorization: 'Bearer good-token' } });
    expect(await verifyAuthSession(req, res)).toEqual({ uid: 'alice', isAnonymous: false });
  });

  it('flags an anonymous session — its uid is a browser, not a person', async () => {
    __testUtils.setValidToken('guest-token', { uid: 'anon-1', firebase: { sign_in_provider: 'anonymous' } });
    const { req, res } = createMockReqRes({ headers: { authorization: 'Bearer guest-token' } });
    expect(await verifyAuthSession(req, res)).toEqual({ uid: 'anon-1', isAnonymous: true });
  });

  it('treats a token with no provider claim as not anonymous', async () => {
    __testUtils.setValidToken('bare-token', { uid: 'bob' });
    const { req, res } = createMockReqRes({ headers: { authorization: 'Bearer bare-token' } });
    expect(await verifyAuthSession(req, res)).toEqual({ uid: 'bob', isAnonymous: false });
  });

  it('returns null and 401 for an invalid token', async () => {
    const { req, res } = createMockReqRes({ headers: { authorization: 'Bearer nope' } });
    expect(await verifyAuthSession(req, res)).toBeNull();
    expect(res.statusCode).toBe(401);
  });
});
