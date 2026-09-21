import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { askOpenAI } from '../lib/providers/openai';
import { askPerplexity } from '../lib/providers/perplexity';
import { askGemini } from '../lib/providers/gemini';
import { db, FieldValue } from '../lib/firebase-admin';
import { log, logInfo, logError, startTimer } from '../lib/logger';
import { reportError } from '../lib/sentry';
import type { VercelRequest, VercelResponse, AskAIRequest, SubscriptionTier } from '../lib/types';

const EXPLORER_DAILY_LIMIT = 3;
const VOYAGER_DAILY_LIMIT = 20;

/** Hard caps on request size, independent of any subscription tier. */
const MAX_PROMPT_LENGTH = 8000;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 8000;

/**
 * Image limits, and why they are what they are.
 *
 * Vercel rejects a request body over ~4.5MB before this handler ever runs, so
 * a cap below that is the difference between a clear error and a mystery. One
 * image at a time is what the only caller sends (a photo of a notebook page),
 * and the ceiling is per-image rather than total so the failure names the
 * file that is too big.
 *
 * Base64 inflates by about a third, so 4MB of base64 is a ~3MB photo — far
 * more than a downscaled page needs. The client is expected to resize before
 * sending; this is the backstop, not the plan.
 */
const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64_LENGTH = 4_000_000;
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * One recording per request, because the caller is a pronunciation exercise:
 * a person reading one passage. Two clips would be two attempts, which is two
 * requests.
 *
 * The size cap is generous on purpose and is not the real limit — Vercel
 * rejects a body over ~4.5MB before this handler runs, and Opus at the bitrate
 * a browser records at puts a minute of speech near 200KB before base64. A
 * clip that reaches this cap is a bug in the client, not a long reading.
 *
 * The MIME list is what Gemini documents for audio input, intersected with
 * what a browser's MediaRecorder actually produces: webm/opus on Chrome,
 * ogg/opus on Firefox, mp4 on Safari. Anything else is rejected here rather
 * than rejected less clearly by the model.
 */
const MAX_AUDIO_CLIPS = 1;
const MAX_AUDIO_BASE64_LENGTH = 4_000_000;
const ALLOWED_AUDIO_MIME = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/aac',
  'audio/flac',
  'audio/opus',
];

/**
 * When LIMITS_ENFORCED=false (opt out explicitly) → limits are paused; everyone is
 *   treated as Explorer for display purposes but no requests are ever blocked.
 *   Useful during testing/beta.
 * Otherwise (default) → tier-based daily quotas are active (Explorer: 3/day, Voyager: 20/day).
 * This proxy holds paid OpenAI/Gemini/Perplexity API keys, so the default must be
 * "enforced" — an unset env var previously meant unlimited usage for anyone.
 * Flip this env var in Vercel dashboard — no code changes needed.
 */
const LIMITS_ENFORCED = process.env.LIMITS_ENFORCED !== 'false';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleCors(req, res)) return;

  const elapsed = startTimer();

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const uid = await verifyAuth(req, res);
  if (!uid) return;

  // ── Subscription quota check ──────────────────────────────────────────────
  const userDoc = await db.collection('users').doc(uid).get();
  const userData = userDoc.data() ?? {};

  // During testing (LIMITS_ENFORCED=false) everyone is treated as explorer;
  // no limits are enforced and no counters are written.
  const tier: SubscriptionTier = LIMITS_ENFORCED
    ? (userData.subscriptionTier ?? 'explorer')
    : 'explorer';

  /**
   * What the user is actually subscribed to.
   *
   * `tier` above is a **quota** decision and is pinned to explorer whenever
   * limits are paused, which is right for counting calls and wrong for
   * anything else. Choosing the model from it would put every paying user on
   * the Explorer model for the whole of a testing period — silently, and
   * precisely when someone is judging output quality.
   */
  const storedTier: SubscriptionTier = userData.subscriptionTier ?? 'explorer';

  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  if (LIMITS_ENFORCED && (tier === 'explorer' || tier === 'voyager')) {
    const dailyLimit = tier === 'explorer' ? EXPLORER_DAILY_LIMIT : VOYAGER_DAILY_LIMIT;
    const upgradeMessage = tier === 'explorer'
      ? 'Daily AI limit reached. Upgrade to Voyager for more.'
      : 'Daily AI limit reached. Upgrade to Maestro for unlimited access.';

    const callsDate: string = userData.aiCallsDate ?? '';
    const callsToday: number = callsDate === today ? (userData.aiCallsToday ?? 0) : 0;

    if (callsToday >= dailyLimit) {
      return errorResponse(res, upgradeMessage, 429);
    }

    // Increment counter before proceeding to avoid a race that lets
    // concurrent requests slip past the daily limit.
    await db.collection('users').doc(uid).set(
      { aiCallsToday: callsToday + 1, aiCallsDate: today, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  }
  // maestro: no daily limit — falls through
  // LIMITS_ENFORCED=false: no limit, no counter write — falls through
  // ─────────────────────────────────────────────────────────────────────────

  const body = req.body as AskAIRequest;

  if (!body?.providerParams?.provider) {
    return errorResponse(res, 'Missing required field: providerParams.provider', 400);
  }
  if (!body?.prompt && (!body?.messages || body.messages.length === 0)) {
    return errorResponse(res, 'Provide either prompt or a non-empty messages array', 400);
  }
  if (body.prompt && body.prompt.length > MAX_PROMPT_LENGTH) {
    return errorResponse(res, `prompt exceeds the maximum length of ${MAX_PROMPT_LENGTH} characters`, 400);
  }
  if (body.images) {
    if (!Array.isArray(body.images) || body.images.length > MAX_IMAGES) {
      return errorResponse(res, `images must be an array of at most ${MAX_IMAGES} entries`, 400);
    }
    // Only Gemini is wired for this. Silently dropping the images on another
    // provider would return a confident answer about a picture it never saw,
    // which reads as a bad model rather than an unsupported request.
    if (body.images.length > 0 && body.providerParams.provider !== 'gemini') {
      return errorResponse(res, 'images are only supported by the gemini provider', 400);
    }
    for (const image of body.images) {
      if (typeof image?.data !== 'string' || image.data.length === 0) {
        return errorResponse(res, 'each image needs a base64 `data` string', 400);
      }
      if (image.data.startsWith('data:')) {
        return errorResponse(res, 'image `data` must be base64 only, without the data: prefix', 400);
      }
      if (image.data.length > MAX_IMAGE_BASE64_LENGTH) {
        return errorResponse(res, 'an image exceeds the maximum size; resize it before sending', 400);
      }
      if (!ALLOWED_IMAGE_MIME.includes(image?.mimeType)) {
        return errorResponse(res, `image mimeType must be one of ${ALLOWED_IMAGE_MIME.join(', ')}`, 400);
      }
    }
  }

  if (body.audio) {
    if (!Array.isArray(body.audio) || body.audio.length > MAX_AUDIO_CLIPS) {
      return errorResponse(res, `audio must be an array of at most ${MAX_AUDIO_CLIPS} entry`, 400);
    }
    // Same reasoning as images: a provider that cannot hear would answer from
    // the prompt alone and produce confident feedback about a recording it
    // never received.
    if (body.audio.length > 0 && body.providerParams.provider !== 'gemini') {
      return errorResponse(res, 'audio is only supported by the gemini provider', 400);
    }
    for (const clip of body.audio) {
      if (typeof clip?.data !== 'string' || clip.data.length === 0) {
        return errorResponse(res, 'each audio clip needs a base64 `data` string', 400);
      }
      if (clip.data.startsWith('data:')) {
        return errorResponse(res, 'audio `data` must be base64 only, without the data: prefix', 400);
      }
      if (clip.data.length > MAX_AUDIO_BASE64_LENGTH) {
        return errorResponse(res, 'the audio clip exceeds the maximum size; record a shorter take', 400);
      }
      // The browser labels a recording `audio/webm;codecs=opus`; the codec
      // parameter is the recorder's business, not ours.
      const baseType = String(clip?.mimeType ?? '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_AUDIO_MIME.includes(baseType)) {
        return errorResponse(res, `audio mimeType must be one of ${ALLOWED_AUDIO_MIME.join(', ')}`, 400);
      }
    }
  }

  if (body.messages) {
    if (body.messages.length > MAX_MESSAGES) {
      return errorResponse(res, `messages exceeds the maximum of ${MAX_MESSAGES} entries`, 400);
    }
    const oversized = body.messages.find((m) => typeof m.content !== 'string' || m.content.length > MAX_MESSAGE_LENGTH);
    if (oversized) {
      return errorResponse(res, `each message's content must be ${MAX_MESSAGE_LENGTH} characters or fewer`, 400);
    }
  }

  const { prompt, messages, images, audio, providerParams } = body;
  const provider = providerParams.provider;

  // ── The Explorer model swap ──────────────────────────────────────────────
  //
  // The request carries two candidates — `model` and `explorerModel` — both
  // read off the admin-edited prompt document, and the server picks. Doing it
  // here rather than in the client is not about trust (the model has always
  // been whatever the client sent) but about plumbing: the tier is already
  // resolved above for quota, and the alternative is threading it through a
  // dozen services that have no other reason to know it.
  //
  // Absent or blank means "the same model as everyone else", which is the
  // state of every prompt nobody has deliberately split.
  if (storedTier === 'explorer' && providerParams.explorerModel) {
    providerParams.model = providerParams.explorerModel;
  }

  const model = providerParams.model ?? 'default';
  const promptLength = prompt?.length ?? 0;
  const messageCount = messages?.length ?? 0;

  logInfo('ai_request_start', 'ask-ai', {
    uid,
    method: req.method,
    provider,
    model,
    tier,
    promptLength,
    messageCount,
    imageCount: images?.length ?? 0,
    audioCount: audio?.length ?? 0,
    explorerModel: storedTier === 'explorer' && !!providerParams.explorerModel,
  });

  try {
    let result;
    switch (provider) {
      case 'perplexity':
        result = await askPerplexity(prompt, providerParams, messages);
        break;
      case 'gemini':
        result = await askGemini(prompt, providerParams, messages, images, audio);
        break;
      case 'openai':
      default:
        result = await askOpenAI(prompt, providerParams, messages);
        break;
    }

    logInfo('ai_request_complete', 'ask-ai', {
      uid,
      method: req.method,
      provider,
      model: result.model ?? model,
      tier,
      statusCode: 200,
      durationMs: elapsed(),
      promptLength,
      messageCount,
    });

    return successResponse(res, result);
  } catch (err: any) {
    const upstreamStatus: number =
      err?.status ?? err?.response?.status ?? err?.statusCode ?? 500;
    const httpStatus =
      upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 500;
    const message = err?.message ?? 'AI request failed';

    const extra = {
      uid,
      method: req.method,
      provider,
      model,
      tier,
      statusCode: httpStatus,
      durationMs: elapsed(),
      upstreamStatus,
    };

    // A 4xx from the provider is the provider answering — a rate limit, a
    // rejected prompt, a context overflow. Those belong in the logs, not in
    // an alert. Anything 5xx (or unrecognized, which defaults to 500) means
    // the provider broke or we did, and that is worth waking up for.
    if (httpStatus >= 500) {
      await reportError('ai_request_error', 'ask-ai', err, extra);
    } else {
      logError('ai_request_error', 'ask-ai', { ...extra, errorMessage: message });
    }

    return errorResponse(res, message, httpStatus);
  }
}
