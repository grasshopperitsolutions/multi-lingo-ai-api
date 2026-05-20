import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { askOpenAI } from '../lib/providers/openai';
import { askPerplexity } from '../lib/providers/perplexity';
import type { VercelRequest, VercelResponse, AskAIRequest } from '../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleCors(req, res)) return;

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

  try {
    const { prompt, messages, providerParams } = body;

    const result =
      providerParams.provider === 'perplexity'
        ? await askPerplexity(prompt, providerParams, messages)
        : await askOpenAI(prompt, providerParams, messages);

    return successResponse(res, result);
  } catch (err: any) {
    const upstreamStatus: number =
      err?.status ?? err?.response?.status ?? err?.statusCode ?? 500;
    const httpStatus =
      upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 500;
    const message = err?.message ?? 'AI request failed';
    console.error(`[ask-ai] Error (${httpStatus}):`, message);
    return errorResponse(res, message, httpStatus);
  }
}
