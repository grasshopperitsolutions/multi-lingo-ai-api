import { describe, it, expect, afterEach, vi } from 'vitest';
import { createMockReqRes, bearer } from '../helpers/httpMocks';

/**
 * Its own file on purpose.
 *
 * `LIMITS_ENFORCED` is read once at module load, so exercising the paused
 * path means `vi.resetModules()` and re-importing the handler. Doing that
 * halfway through a file whose other tests hold static imports of the same
 * modules leaves two live copies — the seeded user lands in one and the
 * handler reads the other, and the test fails for a reason that has nothing
 * to do with the code under test.
 */

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));
vi.mock('../../lib/providers/gemini', () => ({
  askGemini: vi.fn(async () => ({ text: 'gemini-response', provider: 'gemini', model: 'm' })),
}));
vi.mock('../../lib/providers/openai', () => ({ askOpenAI: vi.fn(async () => ({ text: 'openai' })) }));
vi.mock('../../lib/providers/perplexity', () => ({ askPerplexity: vi.fn(async () => ({ text: 'pplx' })) }));

describe('POST /api/ask-ai — paused limits must not choose the model', () => {
  const ORIGINAL = process.env.LIMITS_ENFORCED;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.LIMITS_ENFORCED;
    else process.env.LIMITS_ENFORCED = ORIGINAL;
  });

  /** Boots a fresh handler with limits paused and one user at `tier`. */
  async function callAs(tier: string) {
    process.env.LIMITS_ENFORCED = 'false';
    vi.resetModules();

    const fbAdmin = await import('../helpers/mockFirebaseAdmin');
    fbAdmin.__testUtils.reset();
    fbAdmin.__testUtils.setValidToken('tok', { uid: 'alice' });
    fbAdmin.__testUtils.seedDoc('users', 'alice', { subscriptionTier: tier });

    const { askGemini } = await import('../../lib/providers/gemini');
    const { default: handler } = await import('../../api/ask-ai');

    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer('tok'),
      body: {
        prompt: 'hi',
        providerParams: { provider: 'gemini', model: 'big-model', explorerModel: 'small-model' },
      },
    });
    await handler(req, res);

    // The last call, not the first: the provider mock survives
    // vi.resetModules(), so calls accumulate across the cases in this file
    // and `calls[0]` would be whatever the previous test sent.
    const calls = (askGemini as any).mock.calls;
    return { res, model: calls[calls.length - 1]?.[1]?.model };
  }

  it('keeps a paying user on the shared model while limits are paused', async () => {
    // LIMITS_ENFORCED=false pins the *quota* tier to explorer for everyone,
    // which is right for counting calls and wrong for anything else. Reading
    // the model from it would put every paying user on the cheap model for
    // the whole of a testing period — silently, and precisely when someone is
    // judging output quality.
    const { res, model } = await callAs('maestro');

    expect(res.statusCode).toBe(200);
    expect(model).toBe('big-model');
  });

  // The other direction — a real Explorer still getting the split while
  // limits are paused — is deliberately not re-tested here. It is the same
  // `storedTier` read, already covered with limits enforced in
  // ask-ai.test.ts, and a second vi.resetModules() in one file leaves the
  // provider mock and the handler on different module instances, so the
  // assertion would be measuring the harness rather than the code.
});
