import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockReqRes, bearer } from '../helpers/httpMocks';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils, db } from '../helpers/mockFirebaseAdmin';
import handler from '../../api/storage';

const TOKEN_ALICE = 'token-alice';
const TOKEN_BOB = 'token-bob';

beforeEach(() => {
  __testUtils.reset();
  __testUtils.setValidToken(TOKEN_ALICE, { uid: 'alice' });
  __testUtils.setValidToken(TOKEN_BOB, { uid: 'bob' });
});

describe('POST /api/storage — upload folder/content-type restrictions (finding 2.3)', () => {
  it('allows a default "uploads" upload of any declared content type', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { fileName: 'doc.pdf', contentType: 'application/pdf' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.uploadUrl).toContain('action=write');
  });

  it('rejects an unrecognized folder', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { fileName: 'x.pdf', contentType: 'application/pdf', folder: 'public-cdn' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-image contentType for an avatar upload — previously any file type got public-read hosting', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { fileName: 'payload.html', contentType: 'text/html', folder: 'avatars' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('allows an image contentType for an avatar upload', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { fileName: 'me.png', contentType: 'image/png', folder: 'avatars' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('PUT /api/storage — ownership', () => {
  it('blocks a non-owner from renaming a file', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', fileName: 'bob.pdf', filePath: 'uploads/bob/1_bob.pdf' });
    const { req, res } = createMockReqRes({
      method: 'PUT',
      headers: bearer(TOKEN_ALICE),
      body: { fileId: 'f1', fileName: 'hijacked.pdf' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('allows the owner to rename their file', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', fileName: 'bob.pdf', filePath: 'uploads/bob/1_bob.pdf' });
    const { req, res } = createMockReqRes({
      method: 'PUT',
      headers: bearer(TOKEN_BOB),
      body: { fileId: 'f1', fileName: 'renamed.pdf' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('DELETE /api/storage — prefix scoping (finding 3.3)', () => {
  it('rejects a prefix outside the caller\'s own folder even when it contains the uid as a substring', async () => {
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_ALICE),
      body: { prefix: 'uploads/alice-imposter/' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("rejects another user's real prefix", async () => {
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_ALICE),
      body: { prefix: 'uploads/bob/' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("allows deleting the caller's own uploads prefix", async () => {
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_ALICE),
      body: { prefix: 'uploads/alice/' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("allows deleting the caller's own avatars prefix", async () => {
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_ALICE),
      body: { prefix: 'avatars/alice/' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('blocks a non-owner from deleting a single file by id', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', filePath: 'uploads/bob/1_bob.pdf' });
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_ALICE),
      body: { fileId: 'f1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('allows the owner to delete a single file by id', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', filePath: 'uploads/bob/1_bob.pdf' });
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_BOB),
      body: { fileId: 'f1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/storage — signed download URL ownership', () => {
  it('blocks a non-owner from getting a signed download URL', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', fileName: 'bob.pdf', filePath: 'uploads/bob/1_bob.pdf', contentType: 'application/pdf' });
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ALICE),
      query: { fileId: 'f1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('gives the owner a signed download URL', async () => {
    __testUtils.seedDoc('files', 'f1', { userId: 'bob', fileName: 'bob.pdf', filePath: 'uploads/bob/1_bob.pdf', contentType: 'application/pdf' });
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_BOB),
      query: { fileId: 'f1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.signedUrl).toContain('action=read');
  });
});

describe('unexpected errors (finding 3.1)', () => {
  it('returns a generic message and does not leak internal error details', async () => {
    const spy = vi.spyOn(db, 'collection').mockImplementationOnce(() => {
      throw new Error('internal: bucket permissions denied for project xyz-123');
    });
    const { req, res } = createMockReqRes({
      method: 'GET',
      headers: bearer(TOKEN_ALICE),
      query: { fileId: 'f1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Failed to process storage request');
    expect(res.body.error).not.toMatch(/permissions denied|xyz-123/i);
    spy.mockRestore();
  });
});

describe('unauthenticated requests', () => {
  it('rejects a POST with no Authorization header', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      body: { fileName: 'x.pdf', contentType: 'application/pdf' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });
});
