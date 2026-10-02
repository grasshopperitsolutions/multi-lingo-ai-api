import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import sharp from 'sharp';
import { createMockReqRes, bearer } from '../helpers/httpMocks';

/**
 * Its own file for the reason ask-ai.limits-paused.test.ts gives: LIMITS_ENFORCED
 * is read once, when the handler module loads, so the paused path cannot share a
 * file with tests that need it on.
 *
 * It is set in `vi.hoisted`, which runs before the imports below, rather than
 * with `vi.resetModules()` and a re-import. Resetting modules halfway through a
 * file leaves the handler holding one copy of the Firestore mock while the test
 * seeds another, and the test then fails for a reason that has nothing to do
 * with the code under test (a Maestro read as an Explorer, here).
 */
const ORIGINAL = vi.hoisted(() => {
  const original = process.env.LIMITS_ENFORCED;
  process.env.LIMITS_ENFORCED = 'false';
  return original;
});

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));
vi.mock('../../lib/providers/gemini', () => ({
  askGemini: vi.fn(),
  generateGeminiImage: vi.fn(),
}));

import { __testUtils } from '../helpers/mockFirebaseAdmin';
import { generateGeminiImage } from '../../lib/providers/gemini';
import handler from '../../api/ask-ai';

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.LIMITS_ENFORCED;
  else process.env.LIMITS_ENFORCED = ORIGINAL;
});

let pngBase64 = '';
const conceptIds = ['cat1', 'dog1', 'tree1', 'ball1'];

beforeAll(async () => {
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  pngBase64 = png.toString('base64');
});

beforeEach(() => {
  __testUtils.reset();
  vi.clearAllMocks();
  __testUtils.setValidToken('tok', { uid: 'alice', firebase: { sign_in_provider: 'google.com' } });
  __testUtils.seedDoc('appConfig/config/tiersConfig', 'maestro', { aiCallsPerDay: null });
  __testUtils.seedDoc('appConfig/config/tiersConfig', 'explorer', { aiCallsPerDay: 3 });
  __testUtils.seedDoc('appConfig/config/prompts', 'picture-scene-prompt', {
    template: 'A scene with {{sourceWords}}.',
    model: 's',
  });
  conceptIds.forEach((id, i) => {
    __testUtils.seedDoc('wordPool', id, { sourceWord: ['cat', 'dog', 'tree', 'ball'][i], status: 'ready' });
    __testUtils.seedDoc('conceptPictures', id, { status: 'ready', url: `https://x/${id}.webp` });
  });
  vi.mocked(generateGeminiImage).mockResolvedValue({
    kind: 'image',
    imageData: pngBase64,
    mimeType: 'image/png',
    model: 's',
  } as any);
});

async function sceneAs(tier: string) {
  __testUtils.seedDoc('users', 'alice', { subscriptionTier: tier });
  const { req, res } = createMockReqRes({
    method: 'POST',
    headers: bearer('tok'),
    body: { providerParams: { provider: 'gemini', picture: { action: 'scene', conceptIds } } },
  });
  await handler(req, res);
  return res;
}

describe('POST /api/ask-ai — paused limits and scenes', () => {
  it('still lets a Maestro draw one: the quota tier is pinned to explorer, the plan is not', async () => {
    // Reading the quota tier here would refuse every Maestro for as long as
    // limits are paused, which is precisely when someone is testing.
    const res = await sceneAs('maestro');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.picture.sceneId).toBeTruthy();
  });

  it('still refuses an Explorer', async () => {
    const res = await sceneAs('explorer');
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('SCENE_TIER');
    expect(generateGeminiImage).not.toHaveBeenCalled();
  });
});
