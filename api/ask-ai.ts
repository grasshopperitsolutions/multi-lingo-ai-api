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

  if (!body?.prompt || !body?.providerParams?.provider) {
    return errorResponse(res, 'Missing required fields: prompt, providerParams.provider', 400);
  }

  try {
    const { prompt, providerParams } = body;

    const result =
      providerParams.provider === 'perplexity'
        ? await askPerplexity(prompt, providerParams)
        : await askOpenAI(prompt, providerParams);

    return successResponse(res, result);
  } catch (err: any) {
    console.error('[ask-ai] Error:', err?.message ?? err);
    return errorResponse(res, 'AI request failed', 500);
  }
}
