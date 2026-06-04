import { GoogleGenAI } from '@google/genai';
import type { GeminiParams, AskAIResponse, ChatMessage } from '../types';

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' });

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
  // Default to 'minimal' to keep token usage low unless caller specifies otherwise.
  const thinkingLevel = params.thinkingLevel ?? 'minimal';
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
      },
    });

    // Log token usage — useful for tuning thinkingLevel per feature
    const usage = response.usageMetadata;
    if (usage) {
      console.log(
        `[askGemini] model=${model}` +
        ` input=${usage.promptTokenCount ?? 0}` +
        ` output=${usage.candidatesTokenCount ?? 0}` +
        ` thinking=${(usage as any).thoughtsTokenCount ?? 0}`
      );
    }

    // Safely extract text via candidates to avoid silent empty string from the .text getter
    // (can return '' when finishReason is not STOP, e.g. MAX_TOKENS or safety blocks)
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const text = candidate?.content?.parts?.[0]?.text ?? '';

    if (!text) {
      console.warn(`[askGemini] Empty response text. model=${model} finishReason=${finishReason}`);
    }

    return { text, provider: 'gemini', model };
  } catch (err: any) {
    const code: number = err?.status ?? err?.code ?? err?.response?.status ?? 500;
    const rawMessage: string = err?.message ?? '';

    if (code === 404 || rawMessage.includes('no longer available') || rawMessage.includes('NOT_FOUND')) {
      throw Object.assign(
        new Error(`Gemini model "${model}" is unavailable or deprecated. Please select a different model.`),
        { status: 422 }
      );
    }
    if (code === 429) {
      throw Object.assign(
        new Error('Gemini rate limit reached. Please try again shortly.'),
        { status: 429 }
      );
    }
    if (code === 401 || code === 403) {
      throw Object.assign(
        new Error('Gemini API key is invalid or lacks the required permissions.'),
        { status: 401 }
      );
    }

    throw Object.assign(
      new Error('Gemini request failed. Please try again.'),
      { status: 500 }
    );
  }
}
