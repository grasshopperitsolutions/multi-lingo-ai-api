import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { askOpenAI } from '../lib/providers/openai';
import { askPerplexity } from '../lib/providers/perplexity';
import { askGemini } from '../lib/providers/gemini';
import { db, FieldValue } from '../lib/firebase-admin';
import { log, logInfo, logError, startTimer } from '../lib/logger';
import type { VercelRequest, VercelResponse, AskAIRequest, SubscriptionTier } from '../lib/types';

const EXPLORER_DAILY_LIMIT = 3;
const VOYAGER_DAILY_LIMIT = 20;

/**
 * When LIMITS_ENFORCED=true  → tier-based daily quotas are active (Explorer: 3/day, Voyager: 20/day).
 * When LIMITS_ENFORCED=false (default) → limits are paused; everyone is treated as Explorer
 *   for display purposes but no requests are ever blocked. Useful during testing/beta.
 * Flip this env var in Vercel dashboard — no code changes needed.
 */
const LIMITS_ENFORCED = process.env.LIMITS_ENFORCED === 'true';

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

  const { prompt, messages, providerParams } = body;
  const provider = providerParams.provider;
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
  });

  try {
    let result;
    switch (provider) {
      case 'perplexity':
        result = await askPerplexity(prompt, providerParams, messages);
        break;
      case 'gemini':
        result = await askGemini(prompt, providerParams, messages);
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

    logError('ai_request_error', 'ask-ai', {
      uid,
      method: req.method,
      provider,
      model,
      tier,
      statusCode: httpStatus,
      durationMs: elapsed(),
      errorMessage: message,
      upstreamStatus,
    });

    return errorResponse(res, message, httpStatus);
  }
}
