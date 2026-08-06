import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createMock = vi.fn(async (params: any) => ({
  choices: [{ message: { content: JSON.stringify({ echoed: params }) } }],
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function FakeOpenAI(this: any, opts: any) {
    this.__opts = opts;
    this.chat = { completions: { create: createMock } };
  }),
}));

import OpenAI from 'openai';
import { askPerplexity } from '../../../lib/providers/perplexity';

const ORIGINAL_KEY = process.env.PERPLEXITY_API_KEY;

beforeEach(() => {
  createMock.mockClear();
  vi.mocked(OpenAI).mockClear();
  process.env.PERPLEXITY_API_KEY = 'pplx-test-key';
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.PERPLEXITY_API_KEY;
  else process.env.PERPLEXITY_API_KEY = ORIGINAL_KEY;
});

describe('askPerplexity', () => {
  it('throws when PERPLEXITY_API_KEY is not set', async () => {
    delete process.env.PERPLEXITY_API_KEY;
    await expect(askPerplexity('hi', { provider: 'perplexity' })).rejects.toThrow(/PERPLEXITY_API_KEY/);
  });

  it('points the OpenAI-compatible client at the Perplexity base URL', async () => {
    await askPerplexity('hi', { provider: 'perplexity' });
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'pplx-test-key', baseURL: 'https://api.perplexity.ai' })
    );
  });

  it('applies defaults and wraps a bare prompt', async () => {
    await askPerplexity('hello', { provider: 'perplexity' });
    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.model).toBe('sonar');
    expect(callArgs.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(callArgs.temperature).toBe(0.2);
    expect(callArgs.max_tokens).toBe(300);
  });

  it('forwards every optional Perplexity-specific parameter when provided', async () => {
    await askPerplexity('hi', {
      provider: 'perplexity',
      model: 'sonar-pro',
      top_p: 0.5,
      stream: false,
      stop: ['STOP'],
      response_format: { type: 'json_schema', json_schema: { name: 'x' } },
      search_mode: 'academic',
      disable_search: true,
      enable_search_classifier: true,
      return_images: true,
      return_related_questions: true,
      search_domain_filter: ['example.com'],
      search_language_filter: ['en'],
      search_recency_filter: 'week',
      search_after_date_filter: '01/01/2025',
      search_before_date_filter: '12/31/2025',
      web_search_options: { foo: 'bar' },
      stream_mode: 'concise',
      language_preference: 'en',
      reasoning_effort: 'high',
    });
    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.model).toBe('sonar-pro');
    expect(callArgs.search_mode).toBe('academic');
    expect(callArgs.web_search_options).toEqual({ foo: 'bar' });
    expect(callArgs.reasoning_effort).toBe('high');
  });

  it('omits optional fields entirely when not provided', async () => {
    await askPerplexity('hi', { provider: 'perplexity' });
    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('top_p');
    expect(callArgs).not.toHaveProperty('search_mode');
  });

  it('returns an empty string when the completion has no content', async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: {} }] });
    const result = await askPerplexity('hi', { provider: 'perplexity' });
    expect(result.text).toBe('');
    expect(result.provider).toBe('perplexity');
  });
});
