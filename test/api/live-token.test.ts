import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockReqRes, bearer } from '../helpers/httpMocks';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils } from '../helpers/mockFirebaseAdmin';
import handler from '../../api/live-token';

/**
 * POST /api/live-token
 *
 * The seventh endpoint, and the only one that hands a credential to the
 * browser rather than doing the work itself — the Live API is a stateful
 * WebSocket and a Vercel function cannot hold one open.
 *
 * Two things therefore carry the whole design, and both are tested here: the
 * grant is read from tiersConfig so Admin stays the single source of truth,
 * and every minted token is locked to the live model with `uses: 1`, because
 * "may a session begin" is the only quantity this server can meter once the
 * conversation is happening somewhere it cannot see.
 */

const TOKEN_ALICE = 'token-alice';
const MINTED = 'auth_tokens/abc123';

let fetchMock: ReturnType<typeof vi.fn>;

/** Whatever Admin currently grants. The endpoint must read this, not a constant. */
function seedTiers(featuresByTier: Record<string, string[]>) {
  for (const [tierId, features] of Object.entries(featuresByTier)) {
    __testUtils.seedDoc('appConfig/config/tiersConfig', tierId, { features });
  }
}

beforeEach(() => {
  __testUtils.reset();
  vi.clearAllMocks();
  __testUtils.setValidToken(TOKEN_ALICE, { uid: 'alice' });
  process.env.GEMINI_API_KEY = 'test-key';

  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ name: MINTED }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const post = (body: Record<string, unknown> = {}) =>
  createMockReqRes({ method: 'POST', headers: bearer(TOKEN_ALICE), body });

describe('who may start a session', () => {
  it('rejects an unauthenticated caller', async () => {
    const { req, res } = createMockReqRes({ method: 'POST', body: {} });
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a tier Admin has not granted the feature to', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });
    seedTiers({ explorer: ['challenges'], maestro: ['ai_tutor'] });

    const { req, res } = post();
    await handler(req, res);

    // 403 rather than 401: they are who they say they are, their plan simply
    // does not include this, and the client turns that into an upgrade prompt.
    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows a tier that has it, whichever tier that is', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'voyager' });
    seedTiers({ voyager: ['ai_tutor'] });

    const { req, res } = post();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('follows Admin rather than any tier list of its own', async () => {
    // The point of the Tiers screen: granting the feature to the free tier
    // opens the endpoint to it, with no deploy and no constant to edit here.
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'explorer' });
    seedTiers({ explorer: ['ai_tutor'] });

    const { req, res } = post();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('treats a user with no tier as explorer', async () => {
    __testUtils.seedDoc('users', 'alice', {});
    seedTiers({ explorer: [] });

    const { req, res } = post();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
  });

  it('refuses a caller with no user document at all', async () => {
    // Deliberately not defaulted to explorer. getUserTier returns undefined
    // for a missing document and this endpoint follows it, so an anomalous
    // profile cannot inherit whatever the free tier happens to grant.
    seedTiers({ explorer: ['ai_tutor'], maestro: ['ai_tutor'] });

    const { req, res } = post();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a tier that does not exist in the config at all', async () => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'retired-plan' });
    seedTiers({ maestro: ['ai_tutor'] });

    const { req, res } = post();
    await handler(req, res);

    // Fails closed. An unknown tier grants nothing rather than everything.
    expect(res.statusCode).toBe(403);
  });
});

describe('what the minted token is allowed to do', () => {
  beforeEach(() => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    seedTiers({ maestro: ['ai_tutor'] });
  });

  it('locks the token to the live model and to audio', async () => {
    const { req, res } = post();
    await handler(req, res);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // This is what makes handing a credential to a browser acceptable: a
    // leaked token cannot be spent on a different model or configuration.
    expect(body.bidiGenerateContentSetup.model).toContain('live');
    expect(body.bidiGenerateContentSetup.generationConfig.responseModalities).toEqual(['AUDIO']);
  });

  it('names the setup field bidiGenerateContentSetup, not what the docs call it', async () => {
    // The production bug, and the one most likely to be helpfully undone.
    // Google's ephemeral-token documentation says `liveConnectConstraints`
    // with the modalities under a nested `config`; the AuthToken message has
    // no such field in any API version, and every mint failed with a 400
    // naming it. It carries the Live API's own setup message instead, which
    // keeps modalities under `generationConfig`. Checked against the live
    // endpoint, not read off a page — the JSON validator runs before the API
    // key is, so an invalid key is enough to ask it what it wants.
    const { req, res } = post();
    await handler(req, res);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.bidiGenerateContentSetup).toBeDefined();
    expect(body.liveConnectConstraints).toBeUndefined();
    expect(body.bidiGenerateContentSetup.config).toBeUndefined();
  });

  it('sends the model to Google qualified with models/', async () => {
    // Belt and braces rather than a requirement: bare and qualified both
    // validate. This pins the form Google's own REST examples use, so the
    // model is never the variable when something here has to be debugged.
    const { req, res } = post();
    await handler(req, res);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.bidiGenerateContentSetup.model).toBe('models/gemini-3.8-live-extended-thinking');
  });

  it('does not double-qualify a GEMINI_LIVE_MODEL already set with the prefix', async () => {
    // A plausible mistake: setting the env var to exactly what Google's own
    // docs show, which are themselves qualified.
    process.env.GEMINI_LIVE_MODEL = 'models/gemini-3.8-live';
    vi.resetModules();
    const { default: freshHandler } = await import('../../api/live-token');

    const { req, res } = post();
    await freshHandler(req, res);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.bidiGenerateContentSetup.model).toBe('models/gemini-3.8-live');

    delete process.env.GEMINI_LIVE_MODEL;
  });

  it('returns the bare model name to the browser, not the qualified one', async () => {
    // The response feeds ai.live.connect({ model }) through the SDK, which is
    // documented and used unprefixed everywhere — the qualified form is only
    // ever for the raw REST call above, never for what the browser gets back.
    const { req, res } = post();
    await handler(req, res);

    expect(res.body.data.model).toBe('gemini-3.8-live-extended-thinking');
    expect(res.body.data.model).not.toMatch(/^models\//);
  });

  it('mints it for exactly one session', async () => {
    const { req, res } = post();
    await handler(req, res);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // One mint is one session — the only quantity meterable once the
    // conversation runs where this server cannot see it.
    expect(body.uses).toBe(1);
  });

  it('gives it a short life and a shorter window to open', async () => {
    const { req, res } = post();
    await handler(req, res);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const expire = Date.parse(body.expireTime);
    const open = Date.parse(body.newSessionExpireTime);

    expect(open).toBeLessThan(expire);
    // A token that has not been used within a minute should expire rather
    // than sit in a tab.
    expect(open - Date.now()).toBeLessThanOrEqual(61_000);
  });

  it('returns the token and the model it is good for', async () => {
    const { req, res } = post();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.token).toBe(MINTED);
    expect(res.body.data.model).toContain('live');
    expect(res.body.data.expiresAt).toBeTruthy();
  });

  it('never puts the API key in the response', async () => {
    const { req, res } = post();
    await handler(req, res);

    expect(JSON.stringify(res.body)).not.toContain('test-key');
  });
});

describe('which model the caller asked for', () => {
  beforeEach(() => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    seedTiers({ maestro: ['ai_tutor'] });
  });

  it('mints for the model the caller sent', async () => {
    // Same contract as ask-ai's providerParams.model: the frontend reads it
    // off the admin-edited prompt document and sends it. This endpoint does
    // not read that document — the prompts collection has one reader.
    const { req, res } = post({ model: 'gemini-3.8-live' });
    await handler(req, res);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.bidiGenerateContentSetup.model).toBe('models/gemini-3.8-live');
  });

  it('falls back when the caller names no model', async () => {
    // A fresh install whose prompt document has no model field sends nothing.
    const { req, res } = post();
    await handler(req, res);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.bidiGenerateContentSetup.model).toBe('models/gemini-3.8-live-extended-thinking');
  });

  it('falls back on a blank or non-string model', async () => {
    for (const model of ['', '   ', 42, null]) {
      vi.clearAllMocks();
      const { req, res } = post({ model });
      await handler(req, res);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.bidiGenerateContentSetup.model).toBe('models/gemini-3.8-live-extended-thinking');
    }
  });

  it('echoes back the same model it locked the token to', async () => {
    // The invariant the browser depends on: it opens the session with what
    // came back, and a token only works with the model it was minted for. If
    // these two drifted, every session would mint fine and fail to connect.
    const { req, res } = post({ model: 'gemini-3.8-live' });
    await handler(req, res);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(res.body.data.model).toBe('gemini-3.8-live');
    expect(body.bidiGenerateContentSetup.model).toBe(`models/${res.body.data.model}`);
  });

  it('accepts a model already carrying the models/ prefix', async () => {
    const { req, res } = post({ model: 'models/gemini-3.8-live' });
    await handler(req, res);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.bidiGenerateContentSetup.model).toBe('models/gemini-3.8-live');
  });

  it('truncates an absurdly long model rather than forwarding it', async () => {
    const { req, res } = post({ model: 'x'.repeat(5000) });
    await handler(req, res);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.bidiGenerateContentSetup.model.length).toBeLessThanOrEqual('models/'.length + 200);
  });
});

describe('when it cannot mint', () => {
  beforeEach(() => {
    __testUtils.seedDoc('users', 'alice', { subscriptionTier: 'maestro' });
    seedTiers({ maestro: ['ai_tutor'] });
  });

  it('reports a refusal from Google as a gateway error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

    const { req, res } = post();
    await handler(req, res);

    expect(res.statusCode).toBe(502);
  });

  it('treats a response with no token as a failure', async () => {
    // A 200 carrying nothing usable is still nothing usable.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const { req, res } = post();
    await handler(req, res);

    expect(res.statusCode).toBe(502);
  });

  it('says so when no key is configured, rather than calling out', async () => {
    delete process.env.GEMINI_API_KEY;

    const { req, res } = post();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.GEMINI_API_KEY = 'test-key';
  });

  it('rejects a method other than POST', async () => {
    const { req, res } = createMockReqRes({ method: 'GET', headers: bearer(TOKEN_ALICE) });
    await handler(req, res);

    expect(res.statusCode).toBe(405);
  });
});
