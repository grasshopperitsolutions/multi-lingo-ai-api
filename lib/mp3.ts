/**
 * mp3.ts
 *
 * Compresses the raw PCM that Gemini TTS returns into MP3.
 *
 * Gemini hands back signed 16-bit little-endian mono PCM at 24 kHz with no
 * container — 48 KB per second of speech, 64 KB once base64'd. That is fine
 * to play and hopeless to keep: a twenty-second story paragraph is 1.3 MB of
 * base64, which is past Firestore's 1 MiB document ceiling before any other
 * field is written. Compressed, the same paragraph is about 150 KB and the
 * cache in tts-cache.ts becomes possible at all.
 *
 * ## Why 48 kbps, which looks generous for speech
 *
 * LAME picks its *output* sample rate from the bitrate, and lamejs's resampler
 * is the slowest thing in the encoder. Measured on twenty seconds of 24 kHz
 * mono:
 *
 *   24 kHz in @ 32 kbps -> resampled to 22050 Hz -> 78 KB, 4585 ms
 *   24 kHz in @ 24 kbps -> resampled to 16000 Hz -> 59 KB, 2062 ms
 *   24 kHz in @ 48 kbps -> left at 24000 Hz      -> 118 KB,  397 ms
 *
 * So the obvious frugal settings are the slow ones: they spend seconds
 * resampling, and 22050 from 24000 is an especially awkward ratio. Matching
 * the bitrate to the source rate skips resampling entirely — twelve times
 * faster, no resampling artifacts, and 8x smaller still. A word costs about
 * 20 ms to encode and a minute-long exam transcript about 1.2 s, which is
 * noise beside the seconds of synthesis it follows.
 *
 * Change BITRATE_KBPS and you are choosing a resampler; re-measure before you
 * do.
 */

import lame from '@breezystack/lamejs';
import { logWarn } from './logger';

/** See the header — this value is chosen to avoid resampling, not to hit a size. */
const BITRATE_KBPS = 48;

/** What Gemini returns when the mimeType carries no explicit `rate=`. */
const DEFAULT_SAMPLE_RATE = 24000;

/** One MPEG Layer III granule pair; the encoder wants its input in these. */
const SAMPLES_PER_FRAME = 1152;

export const MP3_MIME = 'audio/mpeg';

/** True for the raw PCM shapes Gemini labels its TTS output with. */
export function isRawPcm(mimeType: string | undefined): boolean {
  return /L16|pcm/i.test(mimeType ?? '');
}

/** Pull `rate=24000` out of `audio/L16;codec=pcm;rate=24000`. */
function parseSampleRate(mimeType: string | undefined): number {
  const match = /rate=(\d+)/i.exec(mimeType ?? '');
  const parsed = match ? parseInt(match[1], 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLE_RATE;
}

/**
 * Compress base64 PCM to base64 MP3.
 *
 * Returns the input untouched when it is not raw PCM (another provider, or a
 * future model that returns a container already) and when encoding fails —
 * a compression problem must never cost the listener their audio, since the
 * bytes in hand are perfectly playable as they are. The caller can tell the
 * two apart by the returned mimeType.
 */
export function compressPcmToMp3(
  audioBase64: string,
  mimeType: string | undefined
): { audioData: string; mimeType: string; compressed: boolean } {
  const original = { audioData: audioBase64, mimeType: mimeType ?? 'audio/wav', compressed: false };

  if (!isRawPcm(mimeType)) return original;

  try {
    const sampleRate = parseSampleRate(mimeType);
    const bytes = Buffer.from(audioBase64, 'base64');

    // A trailing odd byte cannot be half a sample; drop it rather than read
    // past the end of the buffer.
    const sampleCount = Math.floor(bytes.length / 2);
    if (sampleCount === 0) return original;

    const samples = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      samples[i] = bytes.readInt16LE(i * 2);
    }

    const encoder = new lame.Mp3Encoder(1, sampleRate, BITRATE_KBPS);
    const chunks: Buffer[] = [];

    for (let offset = 0; offset < samples.length; offset += SAMPLES_PER_FRAME) {
      const frame = encoder.encodeBuffer(samples.subarray(offset, offset + SAMPLES_PER_FRAME));
      if (frame.length > 0) chunks.push(Buffer.from(frame));
    }

    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(Buffer.from(tail));

    const mp3 = Buffer.concat(chunks);
    if (mp3.length === 0) return original;

    return { audioData: mp3.toString('base64'), mimeType: MP3_MIME, compressed: true };
  } catch (err: any) {
    logWarn('tts_mp3_encode_failed', 'ask-ai', {
      errorMessage: err?.message ?? 'unknown',
      mimeType: mimeType ?? 'unknown',
    });
    return original;
  }
}
