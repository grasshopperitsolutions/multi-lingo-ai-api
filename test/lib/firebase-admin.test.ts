import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

// admin.credential.cert() actually parses the PEM, so a placeholder string
// won't do — generate a throwaway (not secret, never used for real auth) key.
const FAKE_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();

// Deliberately NOT mocked — this exercises the real module's own env-var
// guard (finding 4.5), which only matters when nothing else has stubbed it out.

// Every test here calls vi.resetModules() and then re-imports the real
// lib/firebase-admin, which drags the whole firebase-admin package tree in
// again from cold — and the last one additionally parses a real RSA
// credential and constructs the Firestore and Storage clients. That is
// genuinely slow work, not a hang: it takes well over vitest's 5s default
// once the rest of the suite is running in parallel, which is why this file
// failed intermittently on a developer machine and consistently on CI's
// 2-core runner. Nothing else in the suite pays this cost, because
// everything else mocks the module.
vi.setConfig({ testTimeout: 60_000 });

const ENV_KEYS = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_STORAGE_BUCKET'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
});

describe('lib/firebase-admin — required env var validation (finding 4.5)', () => {
  it('throws a clear error instead of a cryptic Admin SDK failure when all required vars are missing', async () => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    vi.resetModules();
    await expect(import('../../lib/firebase-admin')).rejects.toThrow(/Missing required environment variable/);
  });

  it('names the specific missing variables', async () => {
    process.env.FIREBASE_PROJECT_ID = 'test-project';
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    vi.resetModules();
    await expect(import('../../lib/firebase-admin')).rejects.toThrow(/FIREBASE_CLIENT_EMAIL/);
  });

  it('initializes successfully when all required vars are present', async () => {
    process.env.FIREBASE_PROJECT_ID = 'test-project';
    process.env.FIREBASE_CLIENT_EMAIL = 'test@test-project.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = FAKE_PRIVATE_KEY;
    process.env.FIREBASE_STORAGE_BUCKET = 'test-project.appspot.com';
    vi.resetModules();
    const mod = await import('../../lib/firebase-admin');
    expect(mod.db).toBeDefined();
    expect(mod.auth).toBeDefined();
    expect(mod.storage).toBeDefined();
    expect(mod.FieldValue).toBeDefined();
  });
});
