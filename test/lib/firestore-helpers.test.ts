import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockReqRes } from '../helpers/httpMocks';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils } from '../helpers/mockFirebaseAdmin';
import {
  parseCollectionPath,
  isUsersCollection,
  usersSubcollectionOwner,
  stripProtectedUserFields,
  authorizeUsersDocAccess,
  authorizeGenericDocWrite,
  authorizeGenericDocRead,
  authorizeUsersScopedRead,
  ALWAYS_PROTECTED_USER_FIELDS,
} from '../../lib/firestore-helpers';

beforeEach(() => {
  __testUtils.reset();
});

describe('parseCollectionPath', () => {
  it('splits and trims segments', () => {
    expect(parseCollectionPath('users')).toEqual(['users']);
    expect(parseCollectionPath('users/uid1/notes')).toEqual(['users', 'uid1', 'notes']);
  });

  it('normalizes a trailing/extra slash and whitespace to the same segments as the bare name', () => {
    expect(parseCollectionPath('users/')).toEqual(['users']);
    expect(parseCollectionPath('users//')).toEqual(['users']);
    expect(parseCollectionPath(' users ')).toEqual(['users']);
  });

  it('rejects an empty path', () => {
    expect(() => parseCollectionPath('')).toThrow();
    expect(() => parseCollectionPath('   ')).toThrow();
  });

  it('rejects an even number of segments', () => {
    expect(() => parseCollectionPath('users/uid1')).toThrow();
  });
});

describe('isUsersCollection', () => {
  it('is true only for the bare top-level users collection', () => {
    expect(isUsersCollection(['users'])).toBe(true);
    expect(isUsersCollection(['users', 'uid1', 'notes'])).toBe(false);
    expect(isUsersCollection(['files'])).toBe(false);
  });
});

describe('usersSubcollectionOwner', () => {
  it('returns the owner uid for a nested users path', () => {
    expect(usersSubcollectionOwner(['users', 'uid1', 'notes'])).toBe('uid1');
  });

  it('returns null for the bare users collection or unrelated collections', () => {
    expect(usersSubcollectionOwner(['users'])).toBeNull();
    expect(usersSubcollectionOwner(['files'])).toBeNull();
  });
});

describe('stripProtectedUserFields', () => {
  it('always strips stripe/quota fields regardless of allowTierChange', () => {
    const data = {
      displayName: 'A',
      subscriptionTier: 'admin',
      stripeCustomerId: 'cus_x',
      stripeSubscriptionId: 'sub_x',
      subscriptionStatus: 'active',
      currentPeriodEnd: 123,
      cancelAtPeriodEnd: false,
      aiCallsToday: 999,
      aiCallsDate: '2099-01-01',
    };

    const strippedNoTier = stripProtectedUserFields(data, false);
    expect(strippedNoTier).toEqual({ displayName: 'A' });

    const strippedWithTier = stripProtectedUserFields(data, true);
    expect(strippedWithTier).toEqual({ displayName: 'A', subscriptionTier: 'admin' });
    for (const field of ALWAYS_PROTECTED_USER_FIELDS) {
      expect(strippedWithTier).not.toHaveProperty(field);
    }
  });
});

describe('authorizeUsersDocAccess', () => {
  it('allows self access without an admin check', async () => {
    const { req, res } = createMockReqRes();
    const result = await authorizeUsersDocAccess('uid1', 'uid1', req, res);
    expect(result).toEqual({ ok: true, allowTierChange: false });
    expect(res.statusCode).toBe(200);
  });

  it('denies access to someone else when caller is not admin', async () => {
    __testUtils.seedDoc('users', 'uid1', { subscriptionTier: 'explorer' });
    const { req, res } = createMockReqRes();
    const result = await authorizeUsersDocAccess('uid2', 'uid1', req, res);
    expect(result).toEqual({ ok: false });
    expect(res.statusCode).toBe(403);
  });

  it('allows access to someone else when caller is admin, with tier change allowed', async () => {
    __testUtils.seedDoc('users', 'admin1', { subscriptionTier: 'admin' });
    const { req, res } = createMockReqRes();
    const result = await authorizeUsersDocAccess('uid2', 'admin1', req, res);
    expect(result).toEqual({ ok: true, allowTierChange: true });
  });
});

// A collection path that matches no row in collection-policies.ts, so
// these tests exercise the strict DEFAULT_POLICY (owner-or-admin) fallback.
const UNLISTED_COLLECTION = ['files'];

describe('authorizeGenericDocWrite', () => {
  it('allows the owner via createdBy', async () => {
    const { req, res } = createMockReqRes();
    expect(await authorizeGenericDocWrite(UNLISTED_COLLECTION, { createdBy: 'uid1' }, 'uid1', req, res)).toBe(true);
  });

  it('allows the owner via userId', async () => {
    const { req, res } = createMockReqRes();
    expect(await authorizeGenericDocWrite(UNLISTED_COLLECTION, { userId: 'uid1' }, 'uid1', req, res)).toBe(true);
  });

  it('denies a non-owner who is not admin', async () => {
    __testUtils.seedDoc('users', 'uid2', { subscriptionTier: 'explorer' });
    const { req, res } = createMockReqRes();
    const authorized = await authorizeGenericDocWrite(UNLISTED_COLLECTION, { createdBy: 'uid1' }, 'uid2', req, res);
    expect(authorized).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('fails closed when the document has no owner field at all', async () => {
    __testUtils.seedDoc('users', 'uid1', { subscriptionTier: 'explorer' });
    const { req, res } = createMockReqRes();
    expect(await authorizeGenericDocWrite(UNLISTED_COLLECTION, { someField: 'x' }, 'uid1', req, res)).toBe(false);
  });

  it('allows an admin to write to any document', async () => {
    __testUtils.seedDoc('users', 'admin1', { subscriptionTier: 'admin' });
    const { req, res } = createMockReqRes();
    const authorized = await authorizeGenericDocWrite(UNLISTED_COLLECTION, { createdBy: 'someoneElse' }, 'admin1', req, res);
    expect(authorized).toBe(true);
  });

  it("write:'authenticated' policy collections skip the ownership check entirely", async () => {
    const { req, res } = createMockReqRes();
    const authorized = await authorizeGenericDocWrite(['wordPool'], { createdBy: 'someoneElse' }, 'uid1', req, res);
    expect(authorized).toBe(true);
  });

  it("write:'admin' policy collections require admin regardless of ownership", async () => {
    __testUtils.seedDoc('users', 'uid1', { subscriptionTier: 'explorer' });
    const { req, res } = createMockReqRes();
    const authorized = await authorizeGenericDocWrite(
      ['appConfig', 'config', 'authProviders'],
      { createdBy: 'uid1' },
      'uid1',
      req,
      res
    );
    expect(authorized).toBe(false);
  });

  it("write:'admin' policy collections allow an admin", async () => {
    __testUtils.seedDoc('users', 'admin1', { subscriptionTier: 'admin' });
    const { req, res } = createMockReqRes();
    const authorized = await authorizeGenericDocWrite(
      ['appConfig', 'config', 'authProviders'],
      { createdBy: 'someoneElse' },
      'admin1',
      req,
      res
    );
    expect(authorized).toBe(true);
  });
});

describe('authorizeGenericDocRead', () => {
  it('allows the owner via createdBy', async () => {
    const { req, res } = createMockReqRes();
    expect(await authorizeGenericDocRead(UNLISTED_COLLECTION, { createdBy: 'uid1' }, 'uid1', req, res)).toBe(true);
  });

  it('allows the owner via userId', async () => {
    const { req, res } = createMockReqRes();
    expect(await authorizeGenericDocRead(UNLISTED_COLLECTION, { userId: 'uid1' }, 'uid1', req, res)).toBe(true);
  });

  it('treats a document with no owner field as public and allows it', async () => {
    const { req, res } = createMockReqRes();
    expect(await authorizeGenericDocRead(UNLISTED_COLLECTION, { title: 'shared content' }, 'uid1', req, res)).toBe(true);
  });

  it('denies a non-owner who is not admin when the document does declare an owner', async () => {
    __testUtils.seedDoc('users', 'uid2', { subscriptionTier: 'explorer' });
    const { req, res } = createMockReqRes();
    const authorized = await authorizeGenericDocRead(UNLISTED_COLLECTION, { userId: 'uid1' }, 'uid2', req, res);
    expect(authorized).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('allows an admin to read any owned document', async () => {
    __testUtils.seedDoc('users', 'admin1', { subscriptionTier: 'admin' });
    const { req, res } = createMockReqRes();
    expect(await authorizeGenericDocRead(UNLISTED_COLLECTION, { userId: 'someoneElse' }, 'admin1', req, res)).toBe(true);
  });

  it("read:'public' policy collections are readable even if owned by someone else", async () => {
    const { req, res } = createMockReqRes();
    const authorized = await authorizeGenericDocRead(
      ['appConfig', 'config', 'locales'],
      { createdBy: 'someAdminUid' },
      'uid1',
      req,
      res
    );
    expect(authorized).toBe(true);
  });

  it("read:'authenticated' policy collections (word pools) are readable by any signed-in caller", async () => {
    const { req, res } = createMockReqRes();
    const authorized = await authorizeGenericDocRead(['wordPool'], { createdBy: 'someoneElse' }, 'uid1', req, res);
    expect(authorized).toBe(true);
  });
});

describe('authorizeUsersScopedRead', () => {
  it('allows reading your own users/{uid} doc', async () => {
    const { req, res } = createMockReqRes();
    expect(await authorizeUsersScopedRead(['users'], 'uid1', 'uid1', req, res)).toBe(true);
  });

  it("denies reading someone else's users/{uid} doc when not admin", async () => {
    __testUtils.seedDoc('users', 'uid2', { subscriptionTier: 'explorer' });
    const { req, res } = createMockReqRes();
    expect(await authorizeUsersScopedRead(['users'], 'uid1', 'uid2', req, res)).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('denies browsing the whole users collection (no target id) when not admin', async () => {
    __testUtils.seedDoc('users', 'uid1', { subscriptionTier: 'explorer' });
    const { req, res } = createMockReqRes();
    expect(await authorizeUsersScopedRead(['users'], undefined, 'uid1', req, res)).toBe(false);
  });

  it('allows browsing the whole users collection for an admin', async () => {
    __testUtils.seedDoc('users', 'admin1', { subscriptionTier: 'admin' });
    const { req, res } = createMockReqRes();
    expect(await authorizeUsersScopedRead(['users'], undefined, 'admin1', req, res)).toBe(true);
  });

  it('allows reading your own nested users subcollection', async () => {
    const { req, res } = createMockReqRes();
    expect(await authorizeUsersScopedRead(['users', 'uid1', 'notes'], undefined, 'uid1', req, res)).toBe(true);
  });

  it("denies reading someone else's nested users subcollection when not admin", async () => {
    __testUtils.seedDoc('users', 'uid2', { subscriptionTier: 'explorer' });
    const { req, res } = createMockReqRes();
    expect(await authorizeUsersScopedRead(['users', 'uid1', 'notes'], undefined, 'uid2', req, res)).toBe(false);
  });

  it('allows reading any other collection without extra restriction', async () => {
    const { req, res } = createMockReqRes();
    expect(await authorizeUsersScopedRead(['files'], 'anything', 'uid1', req, res)).toBe(true);
  });
});
