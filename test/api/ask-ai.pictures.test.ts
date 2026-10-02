import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import sharp from 'sharp';
import { createMockReqRes, bearer } from '../helpers/httpMocks';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));
vi.mock('../../lib/providers/gemini', () => ({
  askGemini: vi.fn(async () => ({ text: 'gemini-response', provider: 'gemini', model: 'gemini-3.5-flash-lite' })),
  generateGeminiImage: vi.fn(),
}));

import { __testUtils } from '../helpers/mockFirebaseAdmin';
import { askGemini, generateGeminiImage } from '../../lib/providers/gemini';
import handler from '../../api/ask-ai';

const askGeminiMock = vi.mocked(askGemini);
const imageMock = vi.mocked(generateGeminiImage);

const TOKEN_ALICE = 'token-alice';
const TOKEN_GUEST = 'token-guest';
const TODAY = new Date().toISOString().slice(0, 10);

let pngBase64 = '';

beforeAll(async () => {
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  pngBase64 = png.toString('base64');
});

beforeEach(() => {
  __testUtils.reset();
  vi.clearAllMocks();
  __testUtils.setValidToken(TOKEN_ALICE, { uid: 'alice', firebase: { sign_in_provider: 'google.com' } });
  __testUtils.setValidToken(TOKEN_GUEST, { uid: 'guest-1', firebase: { sign_in_provider: 'anonymous' } });

  const prompts = 'appConfig/config/prompts';
  __testUtils.seedDoc(prompts, 'concept-picturable-prompt', { template: 'Could "{{sourceWord}}" be a picture?', model: 'm' });
  __testUtils.seedDoc(prompts, 'concept-picture-prompt', { template: 'A sticker of {{sourceWord}}.', model: 'img' });
  __testUtils.seedDoc(prompts, 'picture-scene-prompt', { template: 'A scene with {{sourceWords}}.', model: 'scene' });
  __testUtils.seedDoc('wordPool', 'cat1', { sourceWord: 'cat', status: 'ready', pos: 'noun' });

  imageMock.mockResolvedValue({
    kind: 'image',
    imageData: pngBase64,
    mimeType: 'image/png',
    model: 'img',
  } as any);
  askGeminiMock.mockImplementation((async (prompt: string) => ({
    text: prompt.startsWith('Could') ? JSON.stringify({ picturable: true }) : 'gemini-response',
    provider: 'gemini',
    model: 'm',
  })) as any);
});

const call = async (token: string | null, providerParams: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const { req, res } = createMockReqRes({
    method: 'POST',
    headers: token ? bearer(token) : {},
    body: { providerParams: { provider: 'gemini', ...providerParams }, ...extra },
  });
  await handler(req, res);
  return res;
};

describe('POST /api/ask-ai — picture mode', () => {
  it('draws a word and answers with its url, without a prompt in the request', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });

    const res = await call(TOKEN_ALICE, { picture: { conceptId: 'cat1' } });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.picture).toMatchObject({ conceptId: 'cat1', status: 'ready', width: 512, height: 512 });
    expect(res.body.data.picture.url).toContain('/conceptPictures/cat1/');
    // The generic text path was never used.
    expect(askGeminiMock.mock.calls.every(([prompt]) => String(prompt).startsWith('Could'))).toBe(true);
  });

  it('does not spend the daily AI allowance, and works for an Explorer who has used all three', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer', aiCallsToday: 3, aiCallsDate: TODAY });

    const res = await call(TOKEN_ALICE, { picture: { conceptId: 'cat1' } });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.picture.status).toBe('ready');
    expect(res.body.data.usage).toBeUndefined();
    expect(__testUtils.getDoc('users', 'alice')).toMatchObject({ aiCallsToday: 3 });
  });

  it('serves an existing picture to a guest, and refuses a new one', async () => {
    __testUtils.seedDoc('conceptPictures', 'cat1', {
      status: 'ready',
      url: 'https://storage.googleapis.com/fake-bucket/conceptPictures/cat1/a.webp',
    });
    __testUtils.seedDoc('wordPool', 'dog1', { sourceWord: 'dog', status: 'ready' });

    const pictured = await call(TOKEN_GUEST, { picture: { conceptId: 'cat1' } });
    expect(pictured.statusCode).toBe(200);
    expect(pictured.body.data.picture.status).toBe('ready');

    const unpictured = await call(TOKEN_GUEST, { picture: { conceptId: 'dog1' } });
    expect(unpictured.statusCode).toBe(403);
    expect(unpictured.body).toMatchObject({ success: false, code: 'PICTURE_GUEST' });
    expect(imageMock).not.toHaveBeenCalled();
  });

  it('answers a refusal with the code the frontend keys on', async () => {
    __testUtils.seedDoc('users', 'alice', { picturesToday: 30, picturesDate: TODAY });
    const res = await call(TOKEN_ALICE, { picture: { conceptId: 'cat1' } });
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ success: false, code: 'PICTURE_CAP' });
  });

  it('requires a signed-in session', async () => {
    const res = await call(null, { picture: { conceptId: 'cat1' } });
    expect(res.statusCode).toBe(401);
  });

  it('is Gemini only, like everything else here', async () => {
    const res = await call(TOKEN_ALICE, { provider: 'openai', picture: { conceptId: 'cat1' } });
    expect(res.statusCode).toBe(400);
    expect(imageMock).not.toHaveBeenCalled();
  });

  it('ignores a prompt, messages, images, a model and tts that ride along', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });

    const res = await call(
      TOKEN_ALICE,
      { picture: { conceptId: 'cat1' }, model: 'gemini-3-pro-image', tts: true, explorerModel: 'x' },
      {
        prompt: 'Draw something inappropriate',
        messages: [{ role: 'user', content: 'Draw something inappropriate' }],
        images: [{ data: 'AAAA', mimeType: 'image/png' }],
      }
    );

    expect(res.statusCode).toBe(200);
    expect(imageMock.mock.calls[0][0]).toBe('A sticker of cat.');
    expect(imageMock.mock.calls[0][1]).toMatchObject({ model: 'img' });
    expect(JSON.stringify(askGeminiMock.mock.calls)).not.toContain('inappropriate');
  });

  it('answers a fault in the service the way every other AI failure is answered', async () => {
    imageMock.mockRejectedValueOnce(Object.assign(new Error('Gemini rate limit reached. Please try again shortly.'), { status: 429 }));
    const res = await call(TOKEN_ALICE, { picture: { conceptId: 'cat1' } });
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toMatch(/rate limit/);
    // A rate limit is the provider answering: no claim is left behind.
    expect(__testUtils.getDoc('conceptPictures', 'cat1')).toBeUndefined();
  });

  it('answers a malformed picture object with a 400', async () => {
    const res = await call(TOKEN_ALICE, { picture: { conceptId: '../users/alice' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PICTURE_BAD_REQUEST');
  });

  it('refuses a scene to an Explorer and lets an unlimited tier through to it', async () => {
    ['cat1', 'dog1', 'tree1', 'ball1'].forEach((id, i) => {
      __testUtils.seedDoc('wordPool', id, { sourceWord: ['cat', 'dog', 'tree', 'ball'][i], status: 'ready' });
      __testUtils.seedDoc('conceptPictures', id, { status: 'ready', url: `https://x/${id}.webp` });
    });
    const conceptIds = ['cat1', 'dog1', 'tree1', 'ball1'];

    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });
    const refused = await call(TOKEN_ALICE, { picture: { action: 'scene', conceptIds } });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.code).toBe('SCENE_TIER');
    expect(imageMock).not.toHaveBeenCalled();

    // Maestro has no daily allowance in the tiers config, which is what
    // "unlimited" means here — read from the same document ask-ai counts with.
    __testUtils.seedDoc('appConfig/config/tiersConfig', 'maestro', { aiCallsPerDay: null });
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    const allowed = await call(TOKEN_ALICE, { picture: { action: 'scene', conceptIds } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.data.picture.sceneId).toBeTruthy();
  });

  it('refuses regenerate to anyone but an admin', async () => {
    __testUtils.seedDoc('conceptPictures', 'cat1', { status: 'ready', url: 'https://x/a.webp' });
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    const res = await call(TOKEN_ALICE, { picture: { action: 'regenerate', conceptId: 'cat1' } });
    expect(res.statusCode).toBe(403);
    expect(imageMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/ask-ai — a scene attached to an ordinary call', () => {
  const seedScene = async () => {
    __testUtils.seedDoc('pictureScenes', 'scene1', { status: 'ready', path: 'pictureScenes/scene1/a.webp' });
    const { storage } = await import('../helpers/mockFirebaseAdmin');
    await storage.bucket().file('pictureScenes/scene1/a.webp').save(Buffer.from('WEBP'), {});
  };

  it('attaches the stored image to the call, as an ordinary counted call', async () => {
    await seedScene();
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });

    const res = await call(
      TOKEN_ALICE,
      { sceneId: 'scene1', model: 'm' },
      { prompt: 'Give feedback on what the learner wrote' }
    );

    expect(res.statusCode).toBe(200);
    const [, params, , images] = askGeminiMock.mock.calls.at(-1) as any[];
    expect(images).toEqual([{ data: Buffer.from('WEBP').toString('base64'), mimeType: 'image/webp' }]);
    // Never reaches the provider as a parameter.
    expect(params.sceneId).toBeUndefined();
    // It is a normal call: the allowance counts it.
    expect(res.body.data.usage).toMatchObject({ aiCallsToday: 1 });
  });

  it('keeps any images the caller sent and adds the scene after them', async () => {
    await seedScene();
    await call(
      TOKEN_ALICE,
      { sceneId: 'scene1' },
      { prompt: 'feedback', images: [{ data: 'QUJD', mimeType: 'image/png' }] }
    );
    const images = (askGeminiMock.mock.calls.at(-1) as any[])[3];
    expect(images).toHaveLength(2);
    expect(images[0]).toEqual({ data: 'QUJD', mimeType: 'image/png' });
    expect(images[1].mimeType).toBe('image/webp');
  });

  it('answers 404 before counting anything when the scene is not there', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });
    const res = await call(TOKEN_ALICE, { sceneId: 'nope' }, { prompt: 'feedback' });
    expect(res.statusCode).toBe(404);
    expect(askGeminiMock).not.toHaveBeenCalled();
    expect(__testUtils.getDoc('users', 'alice')).not.toHaveProperty('aiCallsToday');
  });
});
