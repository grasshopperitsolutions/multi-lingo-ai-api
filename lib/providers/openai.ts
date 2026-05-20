import OpenAI from 'openai';
import type { OpenAIParams, AskAIResponse } from '../types';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Sends a prompt to OpenAI and returns the text response.
 * Uses response_format: json_object — your prompt MUST instruct the model
 * to return JSON, otherwise the API will throw.
 */
export async function askOpenAI(
  prompt: string,
  params: OpenAIParams
): Promise<AskAIResponse> {
  const model = params.model ?? 'gpt-4o-mini';

  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: params.temperature ?? 0.7,
    max_tokens: params.max_tokens ?? 300,
    response_format: { type: 'json_object' },
  });

  const text = completion.choices[0]?.message?.content ?? '';
  return { text, provider: 'openai', model };
}
