import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockReqRes, bearer } from '../helpers/httpMocks';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));
vi.mock('../../lib/providers/openai', () => ({
  askOpenAI: vi.fn(async () => ({ text: 'openai-response', provider: 'openai', model: 'gpt-4o-mini' })),
}));
vi.mock('../../lib/providers/perplexity', () => ({
  askPerplexity: vi.fn(async () => ({ text: 'perplexity-response', provider: 'perplexity', model: 'sonar' })),
}));
vi.mock('../../lib/providers/gemini', () => ({
  askGemini: vi.fn(async () => ({ text: 'gemini-response', provider: 'gemini', model: 'gemini-3.5-flash-lite' })),
}));

import { __testUtils } from '../helpers/mockFirebaseAdmin';
import { askOpenAI } from '../../lib/providers/openai';
import { askGemini } from '../../lib/providers/gemini';
import handler from '../../api/ask-ai';

const TOKEN_ALICE = 'token-alice';

beforeEach(() => {
  __testUtils.reset();
  vi.clearAllMocks();
  __testUtils.setValidToken(TOKEN_ALICE, { uid: 'alice' });
});

describe('POST /api/ask-ai — auth and validation', () => {
  it('rejects unauthenticated requests', async () => {
    const { req, res } = createMockReqRes({
      method: 'POST',
      body: { prompt: 'hi', providerParams: { provider: 'openai' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('requires providerParams.provider', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { prompt: 'hi' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('requires either prompt or a non-empty messages array', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { providerParams: { provider: 'openai' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a prompt over the max length (finding 3.4)', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { prompt: 'x'.repeat(8001), providerParams: { provider: 'openai' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(askOpenAI).not.toHaveBeenCalled();
  });

  it('rejects too many messages', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    const messages = Array.from({ length: 51 }, () => ({ role: 'user' as const, content: 'hi' }));
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { messages, providerParams: { provider: 'openai' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversized individual message', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { messages: [{ role: 'user', content: 'x'.repeat(8001) }], providerParams: { provider: 'openai' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('routes to the requested provider', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { prompt: 'hi', providerParams: { provider: 'gemini' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(askGemini).toHaveBeenCalled();
    expect(askOpenAI).not.toHaveBeenCalled();
  });
});

describe('POST /api/ask-ai — quota enforcement (finding 2.4)', () => {
  it('enforces the explorer daily limit by default, with no env var set', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });

    for (let i = 0; i < 3; i++) {
      const { req, res } = createMockReqRes({
        method: 'POST',
        headers: bearer(TOKEN_ALICE),
        body: { prompt: 'hi', providerParams: { provider: 'openai' } },
      });
      await handler(req, res);
      expect(res.statusCode).toBe(200);
    }

    const { req, res } = createMockReqRes({
      method: 'POST',
      headers: bearer(TOKEN_ALICE),
      body: { prompt: 'hi', providerParams: { provider: 'openai' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(429);
  });

  it('never limits the maestro tier', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    for (let i = 0; i < 25; i++) {
      const { req, res } = createMockReqRes({
        method: 'POST',
        headers: bearer(TOKEN_ALICE),
        body: { prompt: 'hi', providerParams: { provider: 'openai' } },
      });
      await handler(req, res);
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('POST /api/ask-ai — LIMITS_ENFORCED=false opt-out', () => {
  const ORIGINAL = process.env.LIMITS_ENFORCED;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.LIMITS_ENFORCED;
    else process.env.LIMITS_ENFORCED = ORIGINAL;
  });

  it('does not block requests when explicitly disabled', async () => {
    process.env.LIMITS_ENFORCED = 'false';
    vi.resetModules();

    const fbAdmin = await import('../helpers/mockFirebaseAdmin');
    fbAdmin.__testUtils.reset();
    fbAdmin.__testUtils.setValidToken(TOKEN_ALICE, { uid: 'alice' });
    fbAdmin.__testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });

    const { default: freshHandler } = await import('../../api/ask-ai');

    for (let i = 0; i < 10; i++) {
      const { req, res } = createMockReqRes({
        method: 'POST',
        headers: bearer(TOKEN_ALICE),
        body: { prompt: 'hi', providerParams: { provider: 'openai' } },
      });
      await freshHandler(req, res);
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('method handling', () => {
  it('rejects non-POST methods', async () => {
    const { req, res } = createMockReqRes({ method: 'GET', headers: bearer(TOKEN_ALICE) });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});

describe('POST /api/ask-ai — images', () => {
  /**
   * A student photographs their own notebook and the model reads it. The
   * picture is never stored anywhere: it rides in the request body, is passed
   * to the provider, and goes out of scope with the response.
   */
  const pixel = 'iVBORw0KGgoAAAANSUhEUg';
  const image = { data: pixel, mimeType: 'image/png' };

  const post = (body: Record<string, unknown>) =>
    createMockReqRes({ method: 'POST', headers: bearer(TOKEN_ALICE), body });

  beforeEach(() => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
  });

  it('passes images through to the gemini provider', async () => {
    const { req, res } = post({
      prompt: 'read this page',
      images: [image],
      providerParams: { provider: 'gemini' },
    });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    // Fourth argument, after prompt, params and messages.
    expect((askGemini as any).mock.calls[0][3]).toEqual([image]);
  });

  it('refuses images on a provider that cannot see them', async () => {
    // Dropping them silently would answer confidently about a picture the
    // model never saw, which reads as a bad answer rather than an
    // unsupported request.
    const { req, res } = post({
      prompt: 'read this page',
      images: [image],
      providerParams: { provider: 'openai' },
    });
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(askOpenAI).not.toHaveBeenCalled();
  });

  it('rejects a data: prefix rather than passing it to the model', async () => {
    // A `data:image/png;base64,...` string is the single most likely thing to
    // arrive here, and Gemini needs the payload without it.
    const { req, res } = post({
      prompt: 'read this',
      images: [{ data: `data:image/png;base64,${pixel}`, mimeType: 'image/png' }],
      providerParams: { provider: 'gemini' },
    });
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(askGemini).not.toHaveBeenCalled();
  });

  it('rejects an image type the model does not accept', async () => {
    const { req, res } = post({
      prompt: 'read this',
      images: [{ data: pixel, mimeType: 'image/gif' }],
      providerParams: { provider: 'gemini' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversized image instead of letting the platform reject the body', async () => {
    const { req, res } = post({
      prompt: 'read this',
      images: [{ data: 'A'.repeat(4_000_001), mimeType: 'image/jpeg' }],
      providerParams: { provider: 'gemini' },
    });
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(askGemini).not.toHaveBeenCalled();
  });

  it('rejects more images than the cap', async () => {
    const { req, res } = post({
      prompt: 'read these',
      images: [image, image, image, image, image],
      providerParams: { provider: 'gemini' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('leaves an ordinary text request untouched', async () => {
    const { req, res } = post({ prompt: 'hi', providerParams: { provider: 'gemini' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect((askGemini as any).mock.calls[0][3]).toBeUndefined();
  });
});

describe('POST /api/ask-ai — the Explorer model', () => {
  /**
   * The prompt document carries two models — `model` for everyone and
   * `explorerModel` for the free tier — and the server picks between them.
   * Blank or absent means "the same model as everyone else", which is the
   * state of every prompt nobody has deliberately split.
   */
  const post = (body: Record<string, unknown>) =>
    createMockReqRes({ method: 'POST', headers: bearer(TOKEN_ALICE), body });

  const modelUsed = () => (askGemini as any).mock.calls[0][1].model;

  it('swaps in the Explorer model for an Explorer', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });
    const { req, res } = post({
      prompt: 'hi',
      providerParams: { provider: 'gemini', model: 'big-model', explorerModel: 'small-model' },
    });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(modelUsed()).toBe('small-model');
  });

  it('leaves every other tier on the shared model', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    const { req, res } = post({
      prompt: 'hi',
      providerParams: { provider: 'gemini', model: 'big-model', explorerModel: 'small-model' },
    });
    await handler(req, res);

    expect(modelUsed()).toBe('big-model');
  });

  it('leaves an Explorer on the shared model when no split is configured', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });
    const { req, res } = post({
      prompt: 'hi',
      providerParams: { provider: 'gemini', model: 'big-model' },
    });
    await handler(req, res);

    expect(modelUsed()).toBe('big-model');
  });

  it('treats a blank explorerModel as no split, not as a model id', async () => {
    // An admin clearing the field in the prompt editor leaves "" behind, and
    // "" as a model id is a 400 from the provider rather than a fallback.
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });
    const { req, res } = post({
      prompt: 'hi',
      providerParams: { provider: 'gemini', model: 'big-model', explorerModel: '' },
    });
    await handler(req, res);

    expect(modelUsed()).toBe('big-model');
  });

  it('applies to every provider, not just gemini', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });
    const { req, res } = post({
      prompt: 'hi',
      providerParams: { provider: 'openai', model: 'big-model', explorerModel: 'small-model' },
    });
    await handler(req, res);

    // The split is a tier decision, not a Gemini one — tutor link validation
    // runs on OpenAI and is exactly the kind of call worth making cheaper.
    expect((askOpenAI as any).mock.calls[0][1].model).toBe('small-model');
  });
});
