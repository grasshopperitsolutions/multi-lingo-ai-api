import { describe, it, expect, vi, beforeEach } from 'vitest';

// openai.ts constructs its SDK client at module load time, so the mock
// factory below runs before a plain top-level `const` would be initialized —
// vi.hoisted() lifts this declaration alongside vi.mock's own hoisting.
const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(async (params: any) => ({
    choices: [{ message: { content: JSON.stringify({ echoed: params }) } }],
  })),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function FakeOpenAI() {
    return { chat: { completions: { create: createMock } } };
  }),
}));

import { askOpenAI } from '../../../lib/providers/openai';

beforeEach(() => {
  createMock.mockClear();
});

describe('askOpenAI', () => {
  it('wraps a bare prompt as a single user message and applies defaults', async () => {
    const result = await askOpenAI('hello', { provider: 'openai' });
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(callArgs.temperature).toBe(0.7);
    expect(callArgs.max_tokens).toBe(300);
    expect(callArgs.response_format).toEqual({ type: 'json_object' });
  });

  it('prefers a provided messages array over prompt', async () => {
    const messages = [{ role: 'user' as const, content: 'first' }, { role: 'assistant' as const, content: 'second' }];
    await askOpenAI(undefined, { provider: 'openai' }, messages);
    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.messages).toEqual(messages);
  });

  it('honors explicit model/temperature/max_tokens overrides', async () => {
    await askOpenAI('hi', { provider: 'openai', model: 'gpt-4o', temperature: 0.1, max_tokens: 50 });
    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.model).toBe('gpt-4o');
    expect(callArgs.temperature).toBe(0.1);
    expect(callArgs.max_tokens).toBe(50);
  });

  it('returns an empty string when the completion has no content', async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: {} }] });
    const result = await askOpenAI('hi', { provider: 'openai' });
    expect(result.text).toBe('');
  });
});
