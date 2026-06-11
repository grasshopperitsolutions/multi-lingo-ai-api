/**
 * POST /api/tts
 *
 * Provider-agnostic Text-to-Speech endpoint.
 * The frontend sends { text, locale, gender? } — no provider is specified.
 * This handler resolves the correct provider (Azure or Gemini) and voice
 * via lib/tts-router.ts, then delegates to the appropriate provider.
 *
 * Request body: TtsRequest
 * Response body: { success: true, data: TtsResponse }
 */

import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { resolveTtsRoute } from '../lib/tts-router';
import { askAzureTts } from '../lib/providers/azure-tts';
import { askGemini } from '../lib/providers/gemini';
import { logInfo, logError, startTimer } from '../lib/logger';
import type { VercelRequest, VercelResponse, TtsRequest, TtsResponse } from '../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleCors(req, res)) return;

  const elapsed = startTimer();

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const body = req.body as TtsRequest;

  if (!body?.text?.trim()) {
    return errorResponse(res, 'Missing required field: text', 400);
  }
  if (!body?.locale?.trim()) {
    return errorResponse(res, 'Missing required field: locale', 400);
  }

  const { text, locale, gender = 'female' } = body;

  const { provider, voice } = resolveTtsRoute(locale, gender);

  logInfo('tts_request_start', 'tts', {
    uid,
    locale,
    gender,
    provider,
    voice,
    textLength: text.length,
  });

  try {
    let audioData: string;
    let mimeType: string;

    if (provider === 'azure') {
      const result = await askAzureTts(text, locale, voice);
      audioData = result.audioData!;
      mimeType  = result.mimeType!;
    } else {
      // Gemini TTS — pass resolved voice directly
      const result = await askGemini(text, {
        provider: 'gemini',
        tts: true,
        voice,
        language: locale,
      });
      audioData = result.audioData!;
      mimeType  = result.mimeType!;
    }

    logInfo('tts_request_complete', 'tts', {
      uid,
      locale,
      gender,
      provider,
      voice,
      textLength: text.length,
      statusCode: 200,
      durationMs: elapsed(),
    });

    const response: TtsResponse = { audioData, mimeType, provider, voice };
    return successResponse(res, response);

  } catch (err: any) {
    const upstreamStatus: number =
      err?.status ?? err?.response?.status ?? err?.statusCode ?? 500;
    const httpStatus =
      upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 500;
    const message = err?.message ?? 'TTS request failed';

    logError('tts_request_error', 'tts', {
      uid,
      locale,
      gender,
      provider,
      voice,
      statusCode: httpStatus,
      durationMs: elapsed(),
      errorMessage: message,
    });

    return errorResponse(res, message, httpStatus);
  }
}
