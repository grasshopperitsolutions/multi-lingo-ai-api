import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { GeminiParams, AskAIResponse, ChatMessage } from '../types';
import { logInfo, logWarn } from '../logger';

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' });

// Default TTS model — gemini-2.5-flash-preview-tts is the current stable preview.
// gemini-3.5-flash-preview-tts does NOT exist and should never be used.
const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_TTS_VOICE = 'Sulafat';

/**
 * Sends a prompt to Gemini using the @google/genai SDK.
 *
 * Key parameter notes (confirmed against Google AI docs):
 *  - `config` block maps to GenerationConfig on the API.
 *  - `temperature`: 0–2 float. Controls randomness.
 *  - `maxOutputTokens`: integer. Max tokens in the response.
 *  - `topP`: 0–1 float. Nucleus sampling threshold.
 *  - `topK`: positive integer. Top-k sampling (SDK default if omitted).
 *  - `stopSequences`: string[]. Stop generation at these strings.
 *  - `responseMimeType`: 'application/json' enforces JSON output.
 *  - `responseSchema`: JSON Schema object — guarantees exact output shape
 *    when combined with responseMimeType: 'application/json'.
 *  - `systemInstruction`: string. Prepended as a system turn before contents.
 *  - `thinkingConfig.thinkingLevel`: Gemini 3.x only. Controls thinking tokens.
 *    Values: 'minimal' | 'low' | 'medium' | 'high'. Default: 'minimal'.
 *  - `thinkingConfig.includeThoughts`: Whether to return summarised thinking
 *    in the response. Keep false in production. Default: false.
 *
 * TTS mode (params.tts === true):
 *  - Uses responseModalities: ['AUDIO'] with speechConfig.
 *  - Default model: gemini-2.5-flash-preview-tts.
 *  - Default voice: Sulafat.
 *  - Returns audioData (Base64) and mimeType instead of text.
 *
 * Conversation history: 'system' role messages from ChatMessage[] are
 * forwarded as systemInstruction. 'user'/'assistant' ('model') turns are
 * mapped to the Gemini `contents` array.
 *
 * Default model: gemini-3.5-flash.
 */
export async function askGemini(
  prompt: string | undefined,
  params: GeminiParams,
  messages?: ChatMessage[]
): Promise<AskAIResponse> {
  // Route to TTS branch if requested
  if (params.tts === true) {
    return _askGeminiTts(prompt, params);
  }

  const model = params.model ?? 'gemini-3.5-flash';

  // Separate system messages from conversation turns
  const systemMessages = messages?.filter((m) => m.role === 'system') ?? [];
  const conversationMessages = messages?.filter((m) => m.role !== 'system') ?? [];

  // Build the system instruction (params.systemInstruction wins; else join system messages)
  const systemInstruction =
    params.systemInstruction ??
    (systemMessages.length > 0
      ? systemMessages.map((m) => m.content).join('\n')
      : undefined);

  // Build contents array: multi-turn or single-turn
  let contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;

  if (conversationMessages.length > 0) {
    contents = conversationMessages.map((m) => ({
      // Gemini uses 'model' instead of 'assistant'
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  } else {
    contents = [{ role: 'user', parts: [{ text: prompt ?? '' }] }];
  }

  // Determine if JSON mode should be enabled
  const useJson = params.jsonMode === true || !!params.responseSchema;

  // ── Thinking config (Gemini 3.x) ──────────────────────────────────────────
  // Map our lowercase GeminiThinkingLevel strings to the SDK's uppercase
  // ThinkingLevel enum values (e.g. 'minimal' → ThinkingLevel.MINIMAL).
  const THINKING_LEVEL_MAP: Record<string, ThinkingLevel> = {
    minimal: ThinkingLevel.MINIMAL,
    low: ThinkingLevel.LOW,
    medium: ThinkingLevel.MEDIUM,
    high: ThinkingLevel.HIGH,
  };
  const thinkingLevelKey = params.thinkingLevel ?? 'minimal';
  const thinkingLevel = THINKING_LEVEL_MAP[thinkingLevelKey] ?? ThinkingLevel.MINIMAL;
  const includeThoughts = params.includeThoughts ?? false;
  const thinkingConfig = { thinkingLevel, includeThoughts };

  try {
    const response = await client.models.generateContent({
      model,
      contents,
      config: {
        temperature: params.temperature ?? 0.8,
        maxOutputTokens: params.maxOutputTokens ?? 1024,
        topP: params.topP ?? 0.9,
        ...(params.topK !== undefined ? { topK: params.topK } : {}),
        ...(params.stopSequences ? { stopSequences: params.stopSequences } : {}),
        ...(useJson ? { responseMimeType: 'application/json' } : {}),
        ...(params.responseSchema ? { responseSchema: params.responseSchema } : {}),
        ...(systemInstruction ? { systemInstruction } : {}),
        thinkingConfig,
        // The @google/genai SDK's own HTTP client defaults to a 60s request
        // timeout independent of Vercel's maxDuration or the frontend's fetch
        // timeout — large translation calls were silently getting cut off
        // here even after those two were raised. Kept just under the
        // ask-ai function's 120s maxDuration so a slow call still gets a
        // clean error response instead of Vercel hard-killing the function.
        httpOptions: { timeout: 100000 },
      },
    });

    // Log token usage — useful for tuning thinkingLevel per feature
    const usage = response.usageMetadata;
    if (usage) {
      logInfo('gemini_token_usage', 'ask-ai', {
        model,
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        thinkingTokens: (usage as any).thoughtsTokenCount ?? 0,
      });
    }

    // Safely extract text via candidates to avoid silent empty string from the .text getter
    // (can return '' when finishReason is not STOP, e.g. MAX_TOKENS or safety blocks)
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const text = candidate?.content?.parts?.[0]?.text ?? '';

    if (!text) {
      logWarn('gemini_empty_response', 'ask-ai', { model, finishReason });
    }

    return { text, provider: 'gemini', model };
  } catch (err: any) {
    throw _mapGeminiError(err, model);
  }
}

// ---------------------------------------------------------------------------
// TTS branch — audio output via responseModalities: ['AUDIO']
// ---------------------------------------------------------------------------

async function _askGeminiTts(
  prompt: string | undefined,
  params: GeminiParams
): Promise<AskAIResponse> {
  const model = params.model ?? DEFAULT_TTS_MODEL;
  const voice = params.voice ?? DEFAULT_TTS_VOICE;
  const text = prompt ?? '';

  if (!text.trim()) {
    throw Object.assign(
      new Error('TTS prompt must not be empty.'),
      { status: 400 }
    );
  }

  try {
    const response = await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      } as any,
    });

    const candidate = response.candidates?.[0];
    const part = candidate?.content?.parts?.[0];
    const inlineData = (part as any)?.inlineData;

    if (!inlineData?.data) {
      logWarn('gemini_tts_no_audio', 'ask-ai', { model, voice });
      throw Object.assign(
        new Error('Gemini TTS returned no audio data.'),
        { status: 500 }
      );
    }

    logInfo('gemini_tts_generated', 'ask-ai', {
      model,
      voice,
      mimeType: inlineData.mimeType ?? 'unknown',
      audioBytes: Math.round((inlineData.data.length * 3) / 4),
    });

    return {
      text: '',
      provider: 'gemini',
      model,
      audioData: inlineData.data,
      mimeType: inlineData.mimeType ?? 'audio/wav',
    };
  } catch (err: any) {
    // Re-throw if already mapped
    if (err?.status) throw err;
    throw _mapGeminiError(err, model);
  }
}

// ---------------------------------------------------------------------------
// Shared error mapping
// ---------------------------------------------------------------------------

function _mapGeminiError(err: any, model: string): Error {
  const code: number = err?.status ?? err?.code ?? err?.response?.status ?? 500;
  const rawMessage: string = err?.message ?? '';

  if (code === 404 || rawMessage.includes('no longer available') || rawMessage.includes('NOT_FOUND')) {
    return Object.assign(
      new Error(`Gemini model "${model}" is unavailable or deprecated. Please select a different model.`),
      { status: 422 }
    );
  }
  if (code === 429) {
    return Object.assign(
      new Error('Gemini rate limit reached. Please try again shortly.'),
      { status: 429 }
    );
  }
  if (code === 401 || code === 403) {
    return Object.assign(
      new Error('Gemini API key is invalid or lacks the required permissions.'),
      { status: 401 }
    );
  }

  return Object.assign(
    new Error('Gemini request failed. Please try again.'),
    { status: 500 }
  );
}
