import OpenAI from 'openai';
import type { PerplexityParams, AskAIResponse, ChatMessage } from '../types';

/**
 * Perplexity exposes an OpenAI-compatible chat completions API.
 * We reuse the openai SDK with a custom baseURL + Perplexity API key.
 *
 * NOTE: Perplexity does NOT support response_format: json_object.
 * If you need JSON output, instruct the model explicitly in the prompt.
 */
export async function askPerplexity(
  prompt: string | undefined,
  params: PerplexityParams,
  messages?: ChatMessage[]
): Promise<AskAIResponse> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY env variable is not set');

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.perplexity.ai',
  });

  const model = params.model ?? 'sonar';

  // Use provided messages array or fall back to single-turn prompt
  const resolvedMessages: ChatMessage[] =
    messages && messages.length > 0
      ? messages
      : [{ role: 'user', content: prompt ?? '' }];

  // Destructure known non-API fields so they are not forwarded
  const { provider: _provider, model: _model, ...rest } = params;

  const completion = await client.chat.completions.create({
    model,
    messages: resolvedMessages,
    temperature: rest.temperature ?? 0.2,
    max_tokens: rest.max_tokens ?? 300,
    ...(rest.top_p !== undefined && { top_p: rest.top_p }),
    ...(rest.stream !== undefined && { stream: rest.stream }),
    ...(rest.stop !== undefined && { stop: rest.stop }),
    ...(rest.response_format !== undefined && { response_format: rest.response_format }),
    // Perplexity-specific search params
    ...(rest.search_mode !== undefined && { search_mode: rest.search_mode }),
    ...(rest.disable_search !== undefined && { disable_search: rest.disable_search }),
    ...(rest.enable_search_classifier !== undefined && { enable_search_classifier: rest.enable_search_classifier }),
    ...(rest.return_images !== undefined && { return_images: rest.return_images }),
    ...(rest.return_related_questions !== undefined && { return_related_questions: rest.return_related_questions }),
    ...(rest.search_domain_filter !== undefined && { search_domain_filter: rest.search_domain_filter }),
    ...(rest.search_language_filter !== undefined && { search_language_filter: rest.search_language_filter }),
    ...(rest.search_recency_filter !== undefined && { search_recency_filter: rest.search_recency_filter }),
    ...(rest.search_after_date_filter !== undefined && { search_after_date_filter: rest.search_after_date_filter }),
    ...(rest.search_before_date_filter !== undefined && { search_before_date_filter: rest.search_before_date_filter }),
    ...(rest.web_search_options !== undefined && { web_search_options: rest.web_search_options }),
    ...(rest.stream_mode !== undefined && { stream_mode: rest.stream_mode }),
    ...(rest.language_preference !== undefined && { language_preference: rest.language_preference }),
    ...(rest.reasoning_effort !== undefined && { reasoning_effort: rest.reasoning_effort }),
  } as any);

  const text = (completion as any).choices[0]?.message?.content ?? '';
  return { text, provider: 'perplexity', model };
}
