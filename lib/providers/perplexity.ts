import OpenAI from 'openai';
import type { PerplexityParams, AskAIResponse } from '../types';

/**
 * Perplexity exposes an OpenAI-compatible chat completions API.
 * We reuse the openai SDK with a custom baseURL + Perplexity API key.
 *
 * NOTE: Perplexity does NOT support response_format: json_object.
 * If you need JSON output, instruct the model explicitly in the prompt.
 */
const client = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY,
  baseURL: 'https://api.perplexity.ai',
});

export async function askPerplexity(
  prompt: string,
  params: PerplexityParams
): Promise<AskAIResponse> {
  const model = params.model ?? 'sonar';

  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: params.temperature ?? 0.7,
    max_tokens: params.max_tokens ?? 300,
  });

  const text = completion.choices[0]?.message?.content ?? '';
  return { text, provider: 'perplexity', model };
}
