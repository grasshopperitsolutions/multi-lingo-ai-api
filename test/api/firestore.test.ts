import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockReqRes, bearer } from '../helpers/httpMocks';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils, db } from '../helpers/mockFirebaseAdmin';
import handler from '../../api/firestore';

const TOKEN_ALICE = 'token-alice';
const TOKEN_BOB = 'token-bob';
const TOKEN_ADMIN = 'token-admin';

beforeEach(() => {
  __testUtils.reset();
  __testUtils.setValidToken(TOKEN_ALICE, { uid: 'alice' });
  __testUtils.setValidToken(TOKEN_BOB, { uid: 'bob' });
  __testUtils.setValidToken(TOKEN_ADMIN, { uid: 'admin1' });
  __testUtils.seedDoc('users', 'alice', { email: 'alice@example.com', subscriptionTier: 'explorer' });
  __testUtils.seedDoc('users', 'bob', {
    email: 'bob@example.com',
    subscriptionTier: 'explorer',
    stripeCustomerId: 'cus_bob',
  });
  __testUtils.seedDoc('users', 'admin1', { email: 'admin@example.com', subscriptionTier: 'admin' });
});

describe('GET /api/firestore — single document (finding 1.1)', () => {
  it('rejects an anonymous request with no Authorization header — was fully open before the fix', async () => {
    const { req, res } = createMockReqRes({ method: 'GET', query: { collection: 'users', id: 'bob' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('lets a user read their own profile', async () => {
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ALICE),
      query: { collection: 'users', id: 'alice' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.data.email).toBe('alice@example.com');
  });

  it("blocks an authenticated non-admin from reading someone else's profile", async () => {
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ALICE),
      query: { collection: 'users', id: 'bob' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("lets an admin read someone else's profile", async () => {
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ADMIN),
      query: { collection: 'users', id: 'bob' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('allows reading a non-users document with no declared owner once authenticated (shared content)', async () => {
    __testUtils.seedDoc('lessons', 'l1', { title: 'Intro' });
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ALICE),
      query: { collection: 'lessons', id: 'l1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("blocks reading another user's owned document in a generic collection by guessed/enumerated id", async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', fileName: 'private.pdf' });
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ALICE),
      query: { collection: 'files', id: 'f1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('allows reading your own owned document in a generic collection', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'alice', fileName: 'mine.pdf' });
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ALICE),
      query: { collection: 'files', id: 'f1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/firestore — filtered query (findings 1.2, 1.3, 3.2)', () => {
  it('blocks an unauthenticated filtered query on a non-users collection', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', fileName: 'secret.pdf' });
    const { req, res } = createMockReqRes({
      method: 'GET',
      query: { collection: 'files', filters: JSON.stringify([{ field: 'userId', op: '!=', value: '' }]) },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('blocks a non-admin from listing all users via the exact collection name', async () => {
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ALICE),
      query: { collection: 'users', filters: JSON.stringify([{ field: 'email', op: '!=', value: '' }]) },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('blocks the trailing-slash bypass that previously skipped the admin check entirely', async () => {
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ALICE),
      query: { collection: 'users/', filters: JSON.stringify([{ field: 'email', op: '!=', value: '' }]) },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('allows an admin to list all users', async () => {
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ADMIN),
      query: { collection: 'users', filters: JSON.stringify([{ field: 'email', op: '!=', value: '' }]) },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.documents.length).toBeGreaterThanOrEqual(3);
  });

  it('caps an oversized limit at the server-enforced maximum', async () => {
    for (let i = 0; i < 250; i++) {
      __testUtils.seedDoc('lessons', `l${i}`, { n: i });
    }
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ALICE),
      query: {
        collection: 'lessons',
        filters: JSON.stringify([{ field: 'n', op: '>=', value: 0 }]),
        limit: '999999',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.documents.length).toBe(200);
  });
});

describe('POST /api/firestore — self-escalation and doc-hijack chain (finding 1.4)', () => {
  it("strips subscriptionTier when a user POSTs to their own users/{uid} doc — can't self-promote to admin", async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'users', id: 'alice', data: { subscriptionTier: 'admin', displayName: 'Alice' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    const stored = __testUtils.getDoc('users', 'alice');
    expect(stored?.subscriptionTier).toBe('explorer');
    expect(stored?.displayName).toBe('Alice');
  });

  it('strips stripeCustomerId/stripeSubscriptionId even when an admin sets them — closes the Stripe hijack chain (1.8)', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ADMIN),
      body: { collection: 'users', id: 'bob', data: { stripeCustomerId: 'cus_hijacked', subscriptionTier: 'vip' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    const stored = __testUtils.getDoc('users', 'bob');
    expect(stored?.stripeCustomerId).toBe('cus_bob');
    expect(stored?.subscriptionTier).toBe('vip');
  });

  it("blocks a non-admin from POSTing another user's profile doc", async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'users', id: 'bob', data: { displayName: 'Hijacked' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(__testUtils.getDoc('users', 'bob')?.displayName).not.toBe('Hijacked');
  });

  it('requires an id when writing to the users collection', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'users', data: { displayName: 'X' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("blocks overwriting another user's existing document in a generic collection via a guessed id", async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', fileName: 'bob-file.pdf', createdBy: 'bob' });
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'files', id: 'f1', data: { fileName: 'hijacked.pdf' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(__testUtils.getDoc('files', 'f1')?.fileName).toBe('bob-file.pdf');
  });

  it('allows creating a brand-new document in a generic collection', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'files', data: { fileName: 'new.pdf' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.data.id).toBeTruthy();
  });

  it('lets the owner overwrite their own existing document via POST with an explicit id', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'alice', fileName: 'old.pdf', createdBy: 'alice' });
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'files', id: 'f1', data: { fileName: 'new.pdf', userId: 'alice' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(__testUtils.getDoc('files', 'f1')?.fileName).toBe('new.pdf');
  });
});

describe('PUT/PATCH /api/firestore — ownership bypass on docs without createdBy (finding 1.5)', () => {
  it('blocks a non-owner from updating a `files` doc that only has userId set, not createdBy', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', fileName: 'bob.pdf' });
    const { req, res } = createMockReqRes({
      method: 'PUT',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'files', id: 'f1', data: { fileName: 'hijacked.pdf' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('allows the real owner (matched via userId) to update it', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', fileName: 'bob.pdf' });
    const { req, res } = createMockReqRes({
      method: 'PUT',
      headers: bearer(TOKEN_BOB),
      body: { collection: 'files', id: 'f1', data: { fileName: 'renamed.pdf' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('fails closed for a document with neither createdBy nor userId', async () => {
    __testUtils.seedDoc('mystery', 'm1', { someField: 'x' });
    const { req, res } = createMockReqRes({
      method: 'PATCH',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'mystery', id: 'm1', data: { someField: 'hijacked' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });
});

describe('PUT/PATCH /api/firestore — nested subcollection ownership (finding 1.6)', () => {
  it("blocks writing to someone else's users/{uid}/notes subcollection — previously skipped all checks", async () => {
    __testUtils.seedDoc('users/bob/notes', 'n1', { text: 'private' });
    const { req, res } = createMockReqRes({
      method: 'PUT',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'users/bob/notes', id: 'n1', data: { text: 'hijacked' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(__testUtils.getDoc('users/bob/notes', 'n1')?.text).toBe('private');
  });

  it('allows writing to your own users/{uid}/notes subcollection', async () => {
    __testUtils.seedDoc('users/alice/notes', 'n1', { text: 'mine' });
    const { req, res } = createMockReqRes({
      method: 'PATCH',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'users/alice/notes', id: 'n1', data: { text: 'updated' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(__testUtils.getDoc('users/alice/notes', 'n1')?.text).toBe('updated');
  });

  it('allows an admin to write to a subcollection nested under someone else', async () => {
    __testUtils.seedDoc('users/bob/notes', 'n1', { text: 'private' });
    const { req, res } = createMockReqRes({
      method: 'PUT',
      headers: bearer(TOKEN_ADMIN),
      body: { collection: 'users/bob/notes', id: 'n1', data: { text: 'admin-edit' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('DELETE /api/firestore — users collection deletion (finding 1.5)', () => {
  it('blocks deleting a users/{uid} doc directly, even for the owner — must go through /api/auth', async () => {
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'users', id: 'alice' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(__testUtils.getDoc('users', 'alice')).toBeDefined();
  });

  it('blocks deleting a users/{uid} doc even for an admin', async () => {
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_ADMIN),
      body: { collection: 'users', id: 'bob' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(__testUtils.getDoc('users', 'bob')).toBeDefined();
  });

  it('blocks a non-owner from deleting a files doc missing createdBy', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', fileName: 'bob.pdf' });
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_ALICE),
      body: { collection: 'files', id: 'f1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('allows the owner to delete their own files doc', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', fileName: 'bob.pdf' });
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_BOB),
      body: { collection: 'files', id: 'f1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(__testUtils.getDoc('files', 'f1')).toBeUndefined();
  });
});

describe('unexpected errors (finding 3.1)', () => {
  it('returns a generic message and does not leak internal error details', async () => {
    const spy = vi.spyOn(db, 'collection').mockImplementationOnce(() => {
      throw new Error('internal: firestore composite index missing on project xyz-123');
    });
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ALICE),
      query: { collection: 'lessons', id: 'l1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Failed to process Firestore request');
    expect(res.body.error).not.toMatch(/index missing|xyz-123/i);
    spy.mockRestore();
  });
});

describe('CORS preflight passthrough', () => {
  it('answers OPTIONS without requiring auth', async () => {
    const { req, res } = createMockReqRes({ method: 'OPTIONS' });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('method not allowed', () => {
  it('rejects unsupported HTTP methods', async () => {
    const { req, res } = createMockReqRes({ method: 'TRACE', headers: bearer(TOKEN_ALICE) });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
