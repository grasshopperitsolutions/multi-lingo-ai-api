import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuth } from '../lib/verify-auth';
import { askGemini } from '../lib/providers/gemini';
import type { VercelRequest, VercelResponse, HangmanRequest, HangmanResponse } from '../lib/types';

/**
 * POST /api/hangman
 *
 * Given the user's dialect, the learning dialect, optional interests,
 * and a list of already-seen words, returns a new word and a hint.
 *
 * Body: HangmanRequest
 * Response: HangmanResponse
 *
 * The word is in the learningDialect.
 * The hint is written in the userDialect so the learner understands the clue.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const uid = await verifyAuth(req, res);
  if (!uid) return;

  const body = req.body as HangmanRequest;

  if (!body?.userDialect || !body?.learningDialect) {
    return errorResponse(res, 'Missing required fields: userDialect, learningDialect', 400);
  }

  const { userDialect, learningDialect, interests = [], seenWords = [] } = body;

  const interestLine =
    interests.length > 0
      ? `The user is interested in: ${interests.join(', ')}. Prefer words related to these topics when possible.`
      : 'Choose any common vocabulary word appropriate for a language learner.';

  const seenLine =
    seenWords.length > 0
      ? `Do NOT use any of these already-seen words: ${seenWords.join(', ')}.`
      : '';

  const prompt = `You are a language learning assistant helping a user learn ${learningDialect} vocabulary.

Rules:
1. Choose a single vocabulary word appropriate for ${learningDialect} speakers.
2. ${interestLine}
3. ${seenLine}
4. The word must be a single, common noun or verb. No proper nouns. No compound words.
5. Write the hint/description in ${userDialect} so the learner understands the clue.
6. The hint must describe the word without using the word itself or any direct translation of it.
7. Keep the hint between 10 and 25 words.
8. Return ONLY a JSON object — no markdown, no extra text.

JSON shape:
{
  "word": "<the vocabulary word in ${learningDialect}>",
  "hint": "<the description in ${userDialect}>",
  "dialect": "${learningDialect}"
}`;

  try {
    const aiResult = await askGemini(prompt, {
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      temperature: 0.9,       // higher variety for word selection
      maxOutputTokens: 200,   // word + short hint = well within 200 tokens
      topP: 0.95,
      topK: 40,
      jsonMode: true,         // enforces responseMimeType: 'application/json'
      responseSchema: {
        type: 'object',
        properties: {
          word:    { type: 'string' },
          hint:    { type: 'string' },
          dialect: { type: 'string' },
        },
        required: ['word', 'hint', 'dialect'],
      },
    });

    const parsed = JSON.parse(aiResult.text) as HangmanResponse;

    if (!parsed.word || !parsed.hint) {
      return errorResponse(res, 'AI returned an incomplete response', 502);
    }

    return successResponse(res, parsed);
  } catch (err: any) {
    const message = err?.message ?? 'Hangman AI request failed';
    console.error('[hangman] Error:', message);
    return errorResponse(res, message, 500);
  }
}
