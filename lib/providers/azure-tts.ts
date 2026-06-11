/**
 * Azure Cognitive Services — Text-to-Speech provider
 *
 * Uses the Azure Speech REST API (not the SDK) to keep the bundle small.
 * Docs: https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech
 *
 * Required environment variables (set in Vercel dashboard):
 *   AZURE_SPEECH_KEY    — your Azure Speech resource subscription key
 *   AZURE_SPEECH_REGION — Azure region, e.g. 'eastus' or 'westeurope'
 */

import type { AskAIResponse } from '../types';

const AZURE_TTS_URL = (region: string) =>
  `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

// Output format — 48kHz 192kbps MP3, good quality / reasonable size
const OUTPUT_FORMAT = 'audio-48khz-192kbitrate-mono-mp3';
const OUTPUT_MIME   = 'audio/mpeg';

/**
 * Calls Azure Neural TTS and returns Base64-encoded audio.
 *
 * @param text   - The text to synthesise
 * @param locale - BCP-47 locale, e.g. 'pt-PT'
 * @param voice  - Azure voice ID, e.g. 'pt-PT-FernandaNeural'
 */
export async function askAzureTts(
  text: string,
  locale: string,
  voice: string
): Promise<AskAIResponse> {
  const key    = process.env.AZURE_SPEECH_KEY    ?? '';
  const region = process.env.AZURE_SPEECH_REGION ?? '';

  if (!key || !region) {
    throw Object.assign(
      new Error('Azure TTS is not configured. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.'),
      { status: 500 }
    );
  }

  if (!text.trim()) {
    throw Object.assign(
      new Error('TTS text must not be empty.'),
      { status: 400 }
    );
  }

  const ssml = buildSsml(text, locale, voice);

  let response: Response;
  try {
    response = await fetch(AZURE_TTS_URL(region), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
        'User-Agent': 'multi-lingo-ai',
      },
      body: ssml,
    });
  } catch (err: any) {
    throw Object.assign(
      new Error(`Azure TTS network error: ${err?.message ?? 'unknown'}`),
      { status: 502 }
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`[azure-tts] HTTP ${response.status} — ${body}`);

    if (response.status === 401 || response.status === 403) {
      throw Object.assign(
        new Error('Azure Speech key is invalid or lacks required permissions.'),
        { status: 401 }
      );
    }
    if (response.status === 429) {
      throw Object.assign(
        new Error('Azure TTS rate limit reached. Please try again shortly.'),
        { status: 429 }
      );
    }
    throw Object.assign(
      new Error(`Azure TTS request failed with status ${response.status}.`),
      { status: 502 }
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const audioData   = Buffer.from(arrayBuffer).toString('base64');

  console.log(
    `[azure-tts] locale=${locale} voice=${voice}` +
    ` bytes=${arrayBuffer.byteLength}`
  );

  return {
    text: '',
    provider: 'gemini', // placeholder — ProviderName will be extended in a follow-up
    model: `azure-${voice}`,
    audioData,
    mimeType: OUTPUT_MIME,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SSML builder
// ─────────────────────────────────────────────────────────────────────────────

function buildSsml(text: string, locale: string, voice: string): string {
  // Escape XML special characters to prevent SSML injection
  const safe = text
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');

  return [
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">`,
    `  <voice name="${voice}">${safe}</voice>`,
    `</speak>`,
  ].join('\n');
}
