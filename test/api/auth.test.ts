import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockReqRes, bearer } from '../helpers/httpMocks';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));
vi.mock('../../lib/stripe', () => import('../helpers/mockStripe'));

import { __testUtils, auth } from '../helpers/mockFirebaseAdmin';
import handler from '../../api/auth';

const TOKEN_ALICE = 'token-alice';
const TOKEN_ADMIN = 'token-admin';

beforeEach(() => {
  __testUtils.reset();
  __testUtils.setValidToken(TOKEN_ALICE, { uid: 'alice' });
  __testUtils.setValidToken(TOKEN_ADMIN, { uid: 'admin1' });
  __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });
  __testUtils.seedDoc('users', 'admin1', { subscriptionTier: 'admin' });
});

describe('POST /api/auth — logout', () => {
  it('always succeeds, no auth required', async () => {
    const { req, res } = createMockReqRes({ method: 'POST', body: { action: 'logout' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/auth — unimplemented social providers', () => {
  it.each(['apple', 'facebook', 'twitter'])('returns 501 for %s', async (action) => {
    const { req, res } = createMockReqRes({ method: 'POST', body: { action } });
    await handler(req, res);
    expect(res.statusCode).toBe(501);
  });
});

describe('POST /api/auth — google', () => {
  it('requires an idToken', async () => {
    const { req, res } = createMockReqRes({ method: 'POST', body: { action: 'google' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('creates a new user profile on first sign-in', async () => {
    __testUtils.setValidToken('google-id-token', {
      uid: 'newuser1',
      email: 'new@example.com',
      name: 'New User',
      picture: 'https://example.com/p.png',
      email_verified: true,
    });

    const { req, res } = createMockReqRes({
      method: 'POST',
      body: { action: 'google', idToken: 'google-id-token' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.uid).toBe('newuser1');
    expect(res.body.data.customToken).toBe('custom-token-for-newuser1');

    const stored = __testUtils.getDoc('users', 'newuser1');
    expect(stored?.subscriptionTier).toBe('explorer');
    expect(stored?.email).toBe('new@example.com');
  });

  it('updates the existing profile on repeat sign-in without resetting subscriptionTier', async () => {
    __testUtils.seedAuthUser('alice', { uid: 'alice', email: 'alice@example.com', displayName: 'Alice' });
    __testUtils.setValidToken('google-id-token-alice', {
      uid: 'alice',
      email: 'alice@example.com',
      name: 'Alice Updated',
      email_verified: true,
    });

    const { req, res } = createMockReqRes({
      method: 'POST',
      body: { action: 'google', idToken: 'google-id-token-alice' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(__testUtils.getDoc('users', 'alice')?.subscriptionTier).toBe('explorer');
  });

  it('returns a generic error and does not leak the internal Firebase error message on an invalid token', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      body: { action: 'google', idToken: 'not-a-real-token' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Authentication failed');
    expect(res.body.error).not.toMatch(/signature|expired/i);
  });
});

describe('POST /api/auth — unknown/missing action', () => {
  it('rejects a missing action', async () => {
    const { req, res } = createMockReqRes({ method: 'POST', body: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unrecognized action', async () => {
    const { req, res } = createMockReqRes({ method: 'POST', body: { action: 'nonsense' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/auth', () => {
  it('rejects unauthenticated requests', async () => {
    const { req, res } = createMockReqRes({ method: 'DELETE' });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('lets a user delete their own account', async () => {
    const { req, res } = createMockReqRes({ method: 'DELETE', headers: bearer(TOKEN_ALICE) });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(__testUtils.getDoc('users', 'alice')).toBeUndefined();
  });

  it("blocks a non-admin from deleting someone else's account", async () => {
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_ALICE),
      body: { uid: 'admin1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(__testUtils.getDoc('users', 'admin1')).toBeDefined();
  });

  it("lets an admin delete someone else's account", async () => {
    __testUtils.seedAuthUser('alice');
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_ADMIN),
      body: { uid: 'alice' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(__testUtils.getDoc('users', 'alice')).toBeUndefined();
  });

  it('returns 404 when an admin targets a uid with no Auth record', async () => {
    const { req, res } = createMockReqRes({
      method: 'DELETE',
      headers: bearer(TOKEN_ADMIN),
      body: { uid: 'ghost-uid' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('returns a generic error and does not leak internal details when deletion fails unexpectedly', async () => {
    vi.mocked(auth.deleteUser).mockImplementationOnce(() => {
      throw new Error('internal: quota exceeded on project xyz-123');
    });

    const { req, res } = createMockReqRes({ method: 'DELETE', headers: bearer(TOKEN_ALICE) });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Account deletion failed');
    expect(res.body.error).not.toMatch(/quota|xyz-123/i);
  });
});

describe('method handling', () => {
  it('rejects unsupported methods', async () => {
    const { req, res } = createMockReqRes({ method: 'PUT' });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});

describe('POST /api/auth — interfaceLang seeding', () => {
  const signIn = (body: Record<string, unknown>) =>
    createMockReqRes({ method: 'POST', body: { action: 'google', idToken: 'new-user-token', ...body } });

  beforeEach(() => {
    __testUtils.setValidToken('new-user-token', {
      uid: 'newbie', email: 'newbie@test.local', name: 'Newbie',
    });
  });

  it('seeds the locale the browser reported, so the welcome email matches it', async () => {
    const { req, res } = signIn({ interfaceLang: 'pt-PT' });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(__testUtils.getDoc('users', 'newbie')?.interfaceLang).toBe('pt-PT');
  });

  it('defaults to en-US when the client sends nothing', async () => {
    const { req, res } = signIn({});
    await handler(req, res);
    expect(__testUtils.getDoc('users', 'newbie')?.interfaceLang).toBe('en-US');
  });

  it.each(['../../etc', 'not a locale', 42, null, 'x'.repeat(50)])(
    'falls back to en-US for the invalid value %p rather than storing it',
    async (bad) => {
      const { req, res } = signIn({ interfaceLang: bad });
      await handler(req, res);
      expect(__testUtils.getDoc('users', 'newbie')?.interfaceLang).toBe('en-US');
    }
  );

  it('does not overwrite the language of a returning user', async () => {
    __testUtils.seedDoc('users', 'newbie', { interfaceLang: 'fr-FR', subscriptionTier: 'explorer' });

    const { req, res } = signIn({ interfaceLang: 'de-DE' });
    await handler(req, res);

    // Only the sign-in refresh fields are touched; their chosen language stands.
    expect(__testUtils.getDoc('users', 'newbie')?.interfaceLang).toBe('fr-FR');
  });
});
