import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockReqRes, bearer } from '../helpers/httpMocks';

/**
 * The shared speech cache, from the endpoint's side.
 *
 * Synthesis is charged against the daily quota like any other AI call, so
 * before this existed a twelve-word Word Search put twelve billable buttons
 * on one screen and a reload re-bought every one of them. What these assert
 * is the contract that fixes it: a clip that already exists costs no call, no
 * quota and no provider round-trip — and a user's own typed text never gets
 * into a pool everybody reads from.
 */

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));
vi.mock('../../lib/providers/openai', () => ({
  askOpenAI: vi.fn(async () => ({ text: 'openai-response', provider: 'openai', model: 'gpt-4o-mini' })),
}));
vi.mock('../../lib/providers/perplexity', () => ({
  askPerplexity: vi.fn(async () => ({ text: 'perplexity-response', provider: 'perplexity', model: 'sonar' })),
}));

/** Two samples of silence — valid PCM, and trivially cheap to encode. */
const PCM_BASE64 = Buffer.alloc(4).toString('base64');
const PCM_MIME = 'audio/L16;codec=pcm;rate=24000';

vi.mock('../../lib/providers/gemini', () => ({
  askGemini: vi.fn(async () => ({
    text: '',
    provider: 'gemini',
    model: 'gemini-3.1-flash-tts-preview',
    audioData: PCM_BASE64,
    mimeType: PCM_MIME,
  })),
}));

import { __testUtils } from '../helpers/mockFirebaseAdmin';
import { askGemini } from '../../lib/providers/gemini';
import { TTS_CACHE_COLLECTION, ttsCacheKey } from '../../lib/tts-cache';
import handler from '../../api/ask-ai';

const TOKEN = 'token-alice';
const PROMPT = 'Read the following in European Portuguese: passaporte';
const MODEL = 'gemini-3.1-flash-tts-preview';
const VOICE = 'Sulafat';

const ttsBody = (overrides: Record<string, unknown> = {}) => ({
  prompt: PROMPT,
  providerParams: {
    provider: 'gemini',
    tts: true,
    model: MODEL,
    voice: VOICE,
    language: 'pt-PT',
    cacheable: true,
    ...overrides,
  },
});

const post = async (body: unknown) => {
  const { req, res } = createMockReqRes({ method: 'POST', headers: bearer(TOKEN), body });
  await handler(req, res);
  return res;
};

/** Put a clip in the cache under the key the handler will compute. */
const seedClip = (audioData = 'cached-mp3-bytes', overrides: Record<string, unknown> = {}) => {
  const key = ttsCacheKey({ model: MODEL, voice: VOICE, prompt: PROMPT, ...overrides } as any);
  __testUtils.seedDoc(TTS_CACHE_COLLECTION, key, { audioData, mimeType: 'audio/mpeg' });
  return key;
};

beforeEach(() => {
  __testUtils.reset();
  vi.clearAllMocks();
  __testUtils.setValidToken(TOKEN, { uid: 'alice' });
});

describe('POST /api/ask-ai — serving a cached clip', () => {
  it('returns the stored audio without calling the provider', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    seedClip();

    const res = await post(ttsBody());

    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.audioData).toBe('cached-mp3-bytes');
    expect(res.body?.data?.mimeType).toBe('audio/mpeg');
    expect(askGemini).not.toHaveBeenCalled();
  });

  it('does not spend a daily call on a replay', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });
    seedClip();

    await post(ttsBody());

    // The quota counter is written only when a call is actually made. A
    // replay must leave it entirely untouched, not merely under the limit.
    expect(__testUtils.getDoc('users', 'alice')?.aiCallsToday).toBeUndefined();
  });

  it('still plays for an Explorer who has used up the day', async () => {
    // The point of caching audio: the three calls a day buy new content, and
    // everything already heard stays free forever. Refusing a lookup because
    // the caller is out of calls would be charging for the cache.
    __testUtils.seedDoc('users', 'alice', {
      subscriptionTier: 'explorer',
      aiCallsToday: 3,
      aiCallsDate: new Date().toISOString().slice(0, 10),
    });
    seedClip();

    const res = await post(ttsBody());

    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.audioData).toBe('cached-mp3-bytes');
  });

  it('refuses a generation for that same exhausted Explorer', async () => {
    // The mirror of the test above — the quota gate is intact for anything
    // that is not already in the cache.
    __testUtils.seedDoc('users', 'alice', {
      subscriptionTier: 'explorer',
      aiCallsToday: 3,
      aiCallsDate: new Date().toISOString().slice(0, 10),
    });

    const res = await post(ttsBody());

    expect(res.statusCode).toBe(429);
    expect(askGemini).not.toHaveBeenCalled();
  });
});

describe('POST /api/ask-ai — filling the cache', () => {
  it('compresses a generated clip and keeps it', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });

    const res = await post(ttsBody());

    expect(askGemini).toHaveBeenCalledTimes(1);
    expect(res.body?.data?.mimeType).toBe('audio/mpeg');

    const key = ttsCacheKey({ model: MODEL, voice: VOICE, prompt: PROMPT });
    const stored = __testUtils.getDoc(TTS_CACHE_COLLECTION, key);
    expect(stored?.audioData).toBe(res.body?.data?.audioData);
    expect(stored?.mimeType).toBe('audio/mpeg');
    // Written so a person reading the collection can tell the clips apart.
    expect(stored?.voice).toBe(VOICE);
    expect(stored?.language).toBe('pt-PT');
  });

  it('serves the second identical request from the cache it just filled', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });

    const first = await post(ttsBody());
    const second = await post(ttsBody());

    expect(askGemini).toHaveBeenCalledTimes(1);
    expect(second.body?.data?.audioData).toBe(first.body?.data?.audioData);
  });
});

describe('POST /api/ask-ai — what stays out of the cache', () => {
  it('never stores a clip the caller did not mark cacheable', async () => {
    // The translator, the grammar text page and the dictionary's input box
    // read back what a person typed. Those clips are shared with nobody.
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });

    const res = await post(ttsBody({ cacheable: false }));

    expect(askGemini).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    const key = ttsCacheKey({ model: MODEL, voice: VOICE, prompt: PROMPT });
    expect(__testUtils.getDoc(TTS_CACHE_COLLECTION, key)).toBeUndefined();
  });

  it('does not read the cache for an uncacheable request either', async () => {
    // Even with a matching clip sitting there, an opted-out call generates:
    // otherwise "not cacheable" would quietly mean "write-only", and one
    // user's typed sentence could still be served to another.
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    seedClip();

    const res = await post(ttsBody({ cacheable: false }));

    expect(askGemini).toHaveBeenCalledTimes(1);
    expect(res.body?.data?.audioData).not.toBe('cached-mp3-bytes');
  });

  it('leaves ordinary text completions alone', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });

    await post({ prompt: 'hello', providerParams: { provider: 'gemini', cacheable: true } });

    expect(askGemini).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/ask-ai — what the key covers', () => {
  it('treats a different voice as a different recording', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    seedClip();

    await post(ttsBody({ voice: 'Charon' }));

    expect(askGemini).toHaveBeenCalledTimes(1);
  });

  it('treats an edited prompt template as a different recording', async () => {
    // The pace, the language and the region are all interpolated into the
    // rendered prompt, so hashing it means an admin rewording
    // `tts-build-prompt` invalidates every clip without anyone having to
    // remember a version field.
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    seedClip();

    const { prompt: _drop, ...rest } = ttsBody();
    await post({ prompt: `${PROMPT}, slowly`, ...rest });

    expect(askGemini).toHaveBeenCalledTimes(1);
  });

  it('gives an Explorer on a split model their own recording', async () => {
    // explorerModel is swapped in before the key is computed, so a tier
    // reading a different model is not served the other one's audio.
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });
    seedClip();

    await post(ttsBody({ explorerModel: 'gemini-3.1-flash-tts-cheap' }));

    expect(askGemini).toHaveBeenCalledTimes(1);
    const key = ttsCacheKey({ model: 'gemini-3.1-flash-tts-cheap', voice: VOICE, prompt: PROMPT });
    expect(__testUtils.getDoc(TTS_CACHE_COLLECTION, key)).toBeDefined();
  });
});
