/**
 * In-memory stand-in for lib/firebase-admin.ts, mounted via
 * vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'))
 * in every test file that touches Firestore/Auth/Storage. Keeps the exact
 * named-export shape of the real module (db, auth, storage, FieldValue) so
 * handler code under test doesn't know it's talking to a fake.
 */
import { vi } from 'vitest';

const SERVER_TIMESTAMP = '__SERVER_TIMESTAMP__';

/** Merges `patch` into `base`, resolving FieldValue sentinels (arrayRemove). */
function applyFieldValues(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const remove = (value as any)?.__arrayRemove as unknown[] | undefined;
    if (remove) {
      const current = Array.isArray(result[key]) ? (result[key] as unknown[]) : [];
      result[key] = current.filter((item) => !remove.includes(item));
    } else {
      result[key] = value;
    }
  }
  return result;
}

// collectionPath (e.g. "users" or "users/uid1/notes") -> docId -> data
let store = new Map<string, Map<string, Record<string, unknown>>>();
let authUsers = new Map<string, any>();
let authTokens = new Map<string, any>();

function collectionMap(path: string) {
  if (!store.has(path)) store.set(path, new Map());
  return store.get(path)!;
}

function applyOp(actual: any, op: string, expected: any): boolean {
  switch (op) {
    case '==': return actual === expected;
    case '!=': return actual !== expected;
    case '<': return actual < expected;
    case '<=': return actual <= expected;
    case '>': return actual > expected;
    case '>=': return actual >= expected;
    case 'in': return Array.isArray(expected) && expected.includes(actual);
    case 'not-in': return Array.isArray(expected) && !expected.includes(actual);
    case 'array-contains': return Array.isArray(actual) && actual.includes(expected);
    case 'array-contains-any':
      return Array.isArray(actual) && Array.isArray(expected) && expected.some((v) => actual.includes(v));
    default:
      throw new Error(`Unsupported op in fake firestore: ${op}`);
  }
}

function makeQuery(path: string, filters: Array<{ field: string; op: string; value: any }> = [], orderField?: string, orderDir?: string, limitN?: number): any {
  const query = {
    where(field: string, op: string, value: any) {
      return makeQuery(path, [...filters, { field, op, value }], orderField, orderDir, limitN);
    },
    orderBy(field: string, dir: string = 'asc') {
      return makeQuery(path, filters, field, dir, limitN);
    },
    limit(n: number) {
      return makeQuery(path, filters, orderField, orderDir, n);
    },
    startAfter(_val: any) {
      return makeQuery(path, filters, orderField, orderDir, limitN);
    },
    async get() {
      const map = collectionMap(path);
      let docs = [...map.entries()].map(([id, data]) => ({ id, data }));
      for (const f of filters) {
        docs = docs.filter((d) => applyOp((d.data as any)[f.field], f.op, f.value));
      }
      if (orderField) {
        docs.sort((a, b) => {
          const av = (a.data as any)[orderField];
          const bv = (b.data as any)[orderField];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return orderDir === 'desc' ? -cmp : cmp;
        });
      }
      if (limitN !== undefined) docs = docs.slice(0, limitN);
      return {
        empty: docs.length === 0,
        docs: docs.map((d) => ({ id: d.id, data: () => ({ ...d.data }), ref: makeDocRef(path, d.id) })),
      };
    },
  };
  return query;
}

function makeDocRef(path: string, id: string): any {
  return {
    id,
    path: `${path}/${id}`,
    async get() {
      const data = collectionMap(path).get(id);
      return {
        exists: data !== undefined,
        id,
        data: () => (data ? { ...data } : undefined),
        ref: makeDocRef(path, id),
      };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const map = collectionMap(path);
      if (opts?.merge && map.has(id)) {
        map.set(id, applyFieldValues(map.get(id)!, data));
      } else {
        map.set(id, { ...data });
      }
    },
    async create(data: Record<string, unknown>) {
      const map = collectionMap(path);
      if (map.has(id)) {
        // Mirrors the real SDK: code 6 = ALREADY_EXISTS. The idempotency
        // guard in api/stripe.ts keys off this exact code.
        const err: any = new Error(`Document already exists: ${path}/${id}`);
        err.code = 6;
        throw err;
      }
      map.set(id, { ...data });
    },
    async update(data: Record<string, unknown>) {
      const map = collectionMap(path);
      if (!map.has(id)) {
        throw new Error(`No document to update: ${path}/${id}`);
      }
      map.set(id, applyFieldValues(map.get(id)!, data));
    },
    async delete() {
      collectionMap(path).delete(id);
    },
    collection(subName: string) {
      return makeCollectionRef(`${path}/${id}/${subName}`);
    },
    async listCollections() {
      const prefix = `${path}/${id}/`;
      const names = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const name = key.slice(prefix.length).split('/')[0];
          if (name) names.add(name);
        }
      }
      return [...names].map((name) => makeCollectionRef(`${prefix}${name}`));
    },
  };
}

function makeCollectionRef(path: string): any {
  const q = makeQuery(path);
  return {
    doc(id?: string) {
      return makeDocRef(path, id ?? `auto_${Math.random().toString(36).slice(2, 10)}`);
    },
    async add(data: Record<string, unknown>) {
      const ref = makeDocRef(path, `auto_${Math.random().toString(36).slice(2, 10)}`);
      await ref.set(data);
      return ref;
    },
    where: q.where,
    orderBy: q.orderBy,
    limit: q.limit,
    get: q.get,
  };
}

export const db: any = {
  collection: (name: string) => makeCollectionRef(name),
  doc: (path: string) => {
    const parts = path.split('/');
    const id = parts.pop()!;
    return makeDocRef(parts.join('/'), id);
  },
  batch: () => {
    const ops: Array<() => Promise<void>> = [];
    return {
      delete(ref: any) {
        ops.push(() => ref.delete());
      },
      async commit() {
        for (const op of ops) await op();
      },
    };
  },
};

export const FieldValue = {
  serverTimestamp: () => SERVER_TIMESTAMP,
  /** Sentinel resolved by applyFieldValues() on set(merge)/update. */
  arrayRemove: (...values: unknown[]) => ({ __arrayRemove: values }),
};

export const sendEachForMulticast = vi.fn(async ({ tokens }: { tokens: string[] }) => ({
  successCount: tokens.length,
  failureCount: 0,
  responses: tokens.map(() => ({ success: true })),
}));

export const getMessaging = () => ({ sendEachForMulticast });

export const auth: any = {
  verifyIdToken: vi.fn(async (token: string) => {
    const decoded = authTokens.get(token);
    if (!decoded) {
      const err: any = new Error('Decoded ID token has expired or signature is invalid');
      err.code = 'auth/invalid-id-token';
      throw err;
    }
    return decoded;
  }),
  getUser: vi.fn(async (uid: string) => {
    const record = authUsers.get(uid);
    if (!record) {
      const err: any = new Error('There is no user record corresponding to the provided identifier');
      err.code = 'auth/user-not-found';
      throw err;
    }
    return record;
  }),
  createUser: vi.fn(async (data: any) => {
    const record = { ...data };
    authUsers.set(data.uid, record);
    return record;
  }),
  createCustomToken: vi.fn(async (uid: string) => `custom-token-for-${uid}`),
  deleteUser: vi.fn(async (uid: string) => {
    authUsers.delete(uid);
  }),
};

// ── Storage (Google Cloud Storage) ──────────────────────────────────────────
const storageFiles = new Map<string, Buffer | true>();

function makeFile(filePath: string): any {
  return {
    name: filePath,
    async getSignedUrl(opts: { action: string }) {
      return [`https://storage.googleapis.com/signed/${encodeURIComponent(filePath)}?action=${opts.action}`];
    },
    async copy(destFile: any) {
      storageFiles.set(destFile.name, storageFiles.get(filePath) ?? true);
    },
    async delete() {
      storageFiles.delete(filePath);
    },
  };
}

const bucket = {
  name: 'fake-bucket',
  file: (filePath: string) => makeFile(filePath),
  async deleteFiles(opts: { prefix: string; force?: boolean }) {
    for (const key of [...storageFiles.keys()]) {
      if (key.startsWith(opts.prefix)) storageFiles.delete(key);
    }
  },
};

export const storage: any = {
  bucket: () => bucket,
};

// ── Test utilities (not part of the real module's shape) ───────────────────
export const __testUtils = {
  reset() {
    sendEachForMulticast.mockClear();
    store = new Map();
    authUsers = new Map();
    authTokens = new Map();
    storageFiles.clear();
  },
  seedDoc(collectionPath: string, id: string, data: Record<string, unknown>) {
    collectionMap(collectionPath).set(id, { ...data });
  },
  getDoc(collectionPath: string, id: string) {
    return collectionMap(collectionPath).get(id);
  },
  seedAuthUser(uid: string, record: Record<string, unknown> = {}) {
    authUsers.set(uid, { uid, ...record });
  },
  /** Registers `token` so verifyIdToken(token) resolves to `decoded` (must include uid). */
  setValidToken(token: string, decoded: { uid: string; [key: string]: unknown }) {
    authTokens.set(token, decoded);
  },
  seedStorageFile(filePath: string) {
    storageFiles.set(filePath, true);
  },
  hasStorageFile(filePath: string) {
    return storageFiles.has(filePath);
  },
  dumpCollection(collectionPath: string) {
    return Object.fromEntries(collectionMap(collectionPath));
  },
};
