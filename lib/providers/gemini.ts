import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { GeminiParams, AskAIResponse, ChatMessage, InlineImage, InlineAudio } from '../types';
import { logInfo, logWarn } from '../logger';

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' });

// Default TTS model. The design is 3.8 only: the transcript and the style go
// separately (see _askGeminiTts), which older TTS models do not understand.
// gemini-3.5-flash-preview-tts does NOT exist and should never be used.
const DEFAULT_TTS_MODEL = 'gemini-3.8-flash-tts';
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
 *  - Default model: gemini-3.8-flash-tts, which reads the prompt as a verbatim
 *    transcript; directions go in params.ttsStyle (speech_metadata.style).
 *  - Default voice: Sulafat.
 *  - Returns audioData (Base64) and mimeType instead of text. 3.8 returns a
 *    WAV; older models returned raw PCM. lib/mp3.ts handles both.
 *
 * Conversation history: 'system' role messages from ChatMessage[] are
 * forwarded as systemInstruction. 'user'/'assistant' ('model') turns are
 * mapped to the Gemini `contents` array.
 *
 * Default model: gemini-3.5-flash.
 */
/** A single Gemini content part: text, or an inline image. */
type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export async function askGemini(
  prompt: string | undefined,
  params: GeminiParams,
  messages?: ChatMessage[],
  images?: InlineImage[],
  audio?: InlineAudio[]
): Promise<AskAIResponse> {
  // Route to TTS branch if requested
  if (params.tts === true) {
    return _askGeminiTts(prompt, params);
  }

  const model = params.model ?? 'gemini-3.5-flash-lite';

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
  let contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }>;

  if (conversationMessages.length > 0) {
    contents = conversationMessages.map((m) => ({
      // Gemini uses 'model' instead of 'assistant'
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  } else {
    contents = [{ role: 'user', parts: [{ text: prompt ?? '' }] }];
  }

  // Images ride on the **last user turn**, so they arrive with the
  // instruction that refers to them rather than at the top of a conversation
  // the model has already moved on from. The text part stays first: Gemini's
  // own guidance is that a single image placed after its prompt is read more
  // reliably than one placed before it.
  // Audio rides along the same way and for the same reason — the recording has
  // to arrive with the instruction that says what to listen for. Appended
  // after any images so a request carrying both keeps a stable part order.
  const attachments: Array<InlineImage | InlineAudio> = [...(images ?? []), ...(audio ?? [])];
  if (attachments.length) {
    const lastUserTurn = [...contents].reverse().find((c) => c.role === 'user');
    const target = lastUserTurn ?? contents[contents.length - 1];
    if (target) {
      for (const attachment of attachments) {
        target.parts.push({
          inlineData: { mimeType: attachment.mimeType, data: attachment.data },
        });
      }
    }
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

    // `finishReason` is passed through so callers can tell a truncated
    // response ('MAX_TOKENS') from a complete one. Without it, a reply cut off
    // mid-JSON is indistinguishable from a malformed one, and the caller can't
    // know whether raising maxOutputTokens would help.
    return { text, provider: 'gemini', model, finishReason, tokens: tokensFrom(usage) };
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

  // Gemini 3.8 TTS speaks the text part verbatim, so how to read it travels
  // beside it as `speech_metadata.style` on the same part. Accent and region
  // have to go there too: there is no region setting, and languageCode is
  // ISO 639-1 only (`pt`, never `pt-PT`).
  const style = params.ttsStyle?.trim();
  const part = style ? { text, speechMetadata: { style } } : { text };

  try {
    // Google's 3.8 examples use `voiceConfig: { voice }`; older models took
    // `prebuiltVoiceConfig.voiceName`, which the SDK types still declare. Which
    // one 3.8 accepts is confirmed against the deployed API, so try the
    // established shape first and fall back once if the API refuses it.
    const generate = (voiceConfig: Record<string, unknown>) =>
      client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [part] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig },
        } as any,
      });

    let voiceShape = 'prebuilt';
    let response;
    try {
      response = await generate({ prebuiltVoiceConfig: { voiceName: voice } });
    } catch (firstErr: any) {
      const firstStatus = firstErr?.status ?? firstErr?.code ?? firstErr?.response?.status;
      if (firstStatus !== 400) throw firstErr;
      logWarn('gemini_tts_voice_shape_refused', 'ask-ai', {
        model,
        voiceShape,
        errorMessage: firstErr?.message ?? 'unknown',
      });
      voiceShape = 'voice';
      response = await generate({ voice });
    }

    const candidate = response.candidates?.[0];
    const audioPart = candidate?.content?.parts?.[0];
    const inlineData = (audioPart as any)?.inlineData;

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
      voiceShape,
      styleSent: !!style,
      mimeType: inlineData.mimeType ?? 'unknown',
      audioBytes: Math.round((inlineData.data.length * 3) / 4),
    });

    return {
      text: '',
      provider: 'gemini',
      model,
      tokens: tokensFrom(response.usageMetadata),
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
// Image branch — picture output via responseModalities: ['IMAGE']
// ---------------------------------------------------------------------------

export interface GeminiImageOptions {
  model: string;
  /** '1:1' for a word picture, '4:3' for a scene. */
  aspectRatio: string;
  /** '1K' is the only size the Flash-Lite image model offers. */
  imageSize?: string;
}

/**
 * What an image call comes back with. A refusal is a **result**, not an error:
 * Gemini declining to draw a word (a safety filter, or an answer in words
 * instead of a picture) is the model answering, and the caller records it on
 * the word rather than treating it as a fault in the service.
 */
export type GeminiImageResult =
  | {
      kind: 'image';
      /** Base64 PNG, as the API returns it. The API cannot return a compressed format. */
      imageData: string;
      mimeType: string;
      model: string;
      finishReason?: string;
      tokens?: AskAIResponse['tokens'];
    }
  | {
      kind: 'blocked';
      /** `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT`, a prompt block reason, or `NO_IMAGE`. */
      reason: string;
      model: string;
      finishReason?: string;
      tokens?: AskAIResponse['tokens'];
    };

/**
 * Draw one image.
 *
 * Deliberately **its own function and not a flag on askGemini's params**. A
 * `providerParams.image` that the generic /api/ask-ai path honoured would let
 * any caller have the app's key draw any prompt they typed, which is exactly
 * what lib/pictures.ts exists to prevent: only that module calls this, with a
 * prompt it rendered itself.
 *
 * Same SDK and the same `generateContent` call as text and speech, so there is
 * one code path to keep working (Google's newest docs show the Interactions
 * API instead; not worth a second one for this).
 *
 * Throws for provider faults (bad model id, rate limit, a down service), with
 * the same mapped errors as every other call, so a caller can tell "the model
 * said no" from "the service is broken".
 */
export async function generateGeminiImage(
  prompt: string,
  options: GeminiImageOptions
): Promise<GeminiImageResult> {
  const { model, aspectRatio, imageSize } = options;

  if (!prompt.trim()) {
    throw Object.assign(new Error('Image prompt must not be empty.'), { status: 400 });
  }

  try {
    const response = await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio, ...(imageSize ? { imageSize } : {}) },
        httpOptions: { timeout: 100000 },
      } as any,
    });

    const tokens = tokensFrom(response.usageMetadata);
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;

    // The image is an inline part, but not necessarily the first one: a model
    // that comments before it draws puts a text part ahead of it.
    const imagePart = candidate?.content?.parts?.find((part: any) => part?.inlineData?.data) as any;
    const inlineData = imagePart?.inlineData;

    if (!inlineData?.data) {
      const reason = String(
        (response as any).promptFeedback?.blockReason ?? finishReason ?? 'NO_IMAGE'
      );
      logWarn('gemini_image_blocked', 'ask-ai', { model, reason, finishReason });
      return { kind: 'blocked', reason, model, finishReason, tokens };
    }

    logInfo('gemini_image_generated', 'ask-ai', {
      model,
      aspectRatio,
      mimeType: inlineData.mimeType ?? 'unknown',
      imageBytes: Math.round((inlineData.data.length * 3) / 4),
    });

    return {
      kind: 'image',
      imageData: inlineData.data,
      mimeType: inlineData.mimeType ?? 'image/png',
      model,
      finishReason,
      tokens,
    };
  } catch (err: any) {
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

/** Gemini's usageMetadata as the counters record it; undefined when absent. */
function tokensFrom(usage: any): AskAIResponse['tokens'] {
  if (!usage) return undefined;
  return {
    input: usage.promptTokenCount ?? 0,
    output: usage.candidatesTokenCount ?? 0,
    thinking: usage.thoughtsTokenCount ?? 0,
  };
}
