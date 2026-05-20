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
 *  - `topK`: positive integer. Top-k sampling.
 *  - `stopSequences`: string[]. Stop generation at these strings.
 *  - `responseMimeType`: 'application/json' enforces JSON output.
 *  - `responseSchema`: JSON Schema object — guarantees exact output shape
 *    when combined with responseMimeType: 'application/json'.
 *  - `systemInstruction`: string. Prepended as a system turn before contents.
 *
 * Conversation history: 'system' role messages from ChatMessage[] are
 * forwarded as systemInstruction. 'user'/'assistant' ('model') turns are
 * mapped to the Gemini `contents` array.
 */
export async function askGemini(
  prompt: string | undefined,
  params: GeminiParams,
  messages?: ChatMessage[]
): Promise<AskAIResponse> {
  const model = params.model ?? 'gemini-2.0-flash';

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

  const response = await client.models.generateContent({
    model,
    contents,
    ...(systemInstruction ? { config: { systemInstruction } } : {}),
    config: {
      temperature: params.temperature ?? 0.8,
      maxOutputTokens: params.maxOutputTokens ?? 300,
      topP: params.topP ?? 0.9,
      ...(params.topK !== undefined ? { topK: params.topK } : {}),
      ...(params.stopSequences ? { stopSequences: params.stopSequences } : {}),
      ...(useJson ? { responseMimeType: 'application/json' } : {}),
      ...(params.responseSchema ? { responseSchema: params.responseSchema } : {}),
      ...(systemInstruction ? { systemInstruction } : {}),
    },
  });

  const text = response.text ?? '';
  return { text, provider: 'gemini', model };
}
