import { describe, it, expect, vi, beforeEach } from 'vitest';

// gemini.ts constructs its SDK client at module load time, so the mock
// factory below runs before a plain top-level `const` would be initialized —
// vi.hoisted() lifts this declaration alongside vi.mock's own hoisting.
const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function FakeGoogleGenAI() {
    return { models: { generateContent: generateContentMock } };
  }),
  ThinkingLevel: { MINIMAL: 'MINIMAL', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' },
}));

import { askGemini } from '../../../lib/providers/gemini';

function textResponse(text: string, finishReason = 'STOP') {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
  };
}

beforeEach(() => {
  generateContentMock.mockReset();
});

describe('askGemini — text generation', () => {
  it('wraps a bare prompt with default config', async () => {
    generateContentMock.mockResolvedValueOnce(textResponse('hello back'));
    const result = await askGemini('hello', { provider: 'gemini' });
    expect(result).toEqual({ text: 'hello back', provider: 'gemini', model: 'gemini-3.5-flash-lite' });

    const call = generateContentMock.mock.calls[0][0];
    expect(call.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
    expect(call.config.temperature).toBe(0.8);
    expect(call.config.maxOutputTokens).toBe(1024);
    expect(call.config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL', includeThoughts: false });
  });

  it('splits system messages into systemInstruction and maps assistant -> model turns', async () => {
    generateContentMock.mockResolvedValueOnce(textResponse('ok'));
    await askGemini(undefined, { provider: 'gemini' }, [
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    const call = generateContentMock.mock.calls[0][0];
    expect(call.config.systemInstruction).toBe('be nice');
    expect(call.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ]);
  });

  it('lets explicit systemInstruction override derived system messages', async () => {
    generateContentMock.mockResolvedValueOnce(textResponse('ok'));
    await askGemini('hi', { provider: 'gemini', systemInstruction: 'override' });
    expect(generateContentMock.mock.calls[0][0].config.systemInstruction).toBe('override');
  });

  it('enables JSON mode when responseSchema is provided even without jsonMode', async () => {
    generateContentMock.mockResolvedValueOnce(textResponse('{}'));
    const schema = { type: 'object', properties: {} };
    await askGemini('hi', { provider: 'gemini', responseSchema: schema });
    const call = generateContentMock.mock.calls[0][0];
    expect(call.config.responseMimeType).toBe('application/json');
    expect(call.config.responseSchema).toBe(schema);
  });

  it('maps each thinkingLevel to the SDK enum', async () => {
    generateContentMock.mockResolvedValue(textResponse('ok'));
    await askGemini('hi', { provider: 'gemini', thinkingLevel: 'high', includeThoughts: true });
    const call = generateContentMock.mock.calls[0][0];
    expect(call.config.thinkingConfig).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true });
  });

  it('returns an empty string when finishReason is not STOP', async () => {
    generateContentMock.mockResolvedValueOnce(textResponse('', 'MAX_TOKENS'));
    const result = await askGemini('hi', { provider: 'gemini' });
    expect(result.text).toBe('');
  });
});

describe('askGemini — TTS mode', () => {
  it('returns audio data for a valid TTS request', async () => {
    generateContentMock.mockResolvedValueOnce({
      candidates: [{ content: { parts: [{ inlineData: { data: 'QUJD', mimeType: 'audio/wav' } }] } }],
    });
    const result = await askGemini('speak this', { provider: 'gemini', tts: true, voice: 'Kore' });
    expect(result.provider).toBe('gemini');
    expect(result.audioData).toBe('QUJD');
    expect(result.mimeType).toBe('audio/wav');
  });

  it('rejects an empty TTS prompt with a 400', async () => {
    await expect(askGemini('   ', { provider: 'gemini', tts: true })).rejects.toMatchObject({ status: 400 });
  });

  it('maps a missing audio payload to a 500', async () => {
    generateContentMock.mockResolvedValueOnce({ candidates: [{ content: { parts: [{}] } }] });
    await expect(askGemini('speak', { provider: 'gemini', tts: true })).rejects.toMatchObject({ status: 500 });
  });
});

describe('askGemini — error mapping', () => {
  it('maps a 404/NOT_FOUND upstream error to 422', async () => {
    generateContentMock.mockRejectedValueOnce({ status: 404, message: 'model not found' });
    await expect(askGemini('hi', { provider: 'gemini' })).rejects.toMatchObject({ status: 422 });
  });

  it('maps a 429 upstream error to 429', async () => {
    generateContentMock.mockRejectedValueOnce({ status: 429, message: 'slow down' });
    await expect(askGemini('hi', { provider: 'gemini' })).rejects.toMatchObject({ status: 429 });
  });

  it('maps 401/403 upstream errors to 401', async () => {
    generateContentMock.mockRejectedValueOnce({ status: 403, message: 'forbidden' });
    await expect(askGemini('hi', { provider: 'gemini' })).rejects.toMatchObject({ status: 401 });
  });

  it('maps any other upstream error to 500', async () => {
    generateContentMock.mockRejectedValueOnce({ status: 502, message: 'bad gateway' });
    await expect(askGemini('hi', { provider: 'gemini' })).rejects.toMatchObject({ status: 500 });
  });
});
