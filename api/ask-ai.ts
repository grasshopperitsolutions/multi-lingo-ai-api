import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { askOpenAI } from '../lib/providers/openai';
import { askPerplexity } from '../lib/providers/perplexity';
import { askGemini } from '../lib/providers/gemini';
import { log, logInfo, logError, startTimer } from '../lib/logger';
import type { VercelRequest, VercelResponse, AskAIRequest } from '../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleCors(req, res)) return;

  const elapsed = startTimer();

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const uid = await verifyAuth(req, res);
  if (!uid) return;

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
      statusCode: httpStatus,
      durationMs: elapsed(),
      errorMessage: message,
      upstreamStatus,
    });

    return errorResponse(res, message, httpStatus);
  }
}
