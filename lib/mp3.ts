/**
 * mp3.ts
 *
 * Compresses the PCM that Gemini TTS returns into MP3.
 *
 * Gemini 3.1 and earlier hand back signed 16-bit little-endian mono PCM at
 * 24 kHz with no container; 3.8 returns the same samples inside a WAV. Either
 * way it is 48 KB per second of speech, 64 KB once base64'd. That is fine
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

import { logInfo, logWarn } from './logger';

/**
 * ## The encoder is loaded lazily, and that is not an optimisation
 *
 * `import lame from '@breezystack/lamejs'` at the top of this file took
 * **`/api/ask-ai` down in production** — every AI feature in the app, for
 * every user, from the moment the TTS cache deployed until it was found.
 *
 * The package declares `"type": "module"` and points its `require` condition
 * at `dist/lamejs.iife.js`, a *browser* IIFE bundle. Vercel compiles these
 * handlers to CommonJS, so the static import became a `require()` of a file
 * Node considers ESM, and Node refuses:
 *
 *     ERR_REQUIRE_ESM: require() of ES Module .../lamejs.iife.js
 *     from /var/task/lib/mp3.js not supported.
 *
 * Thrown while the *module* was loading, so the handler never ran at all —
 * not even the CORS preflight, which is why the browser reported it as "no
 * Access-Control-Allow-Origin" and it read as a CORS misconfiguration. Same
 * misdiagnosis this repo already documents for firebase-admin v14: a
 * platform-level 500 carries no CORS headers.
 *
 * It passed every local check. `node -e "require('@breezystack/lamejs')"`
 * returns `{}` here rather than throwing, because newer Node can require ESM;
 * Vercel's runtime cannot. **`npm test` and `npm run typecheck` cannot see
 * this class of fault** — it is a resolution difference between two runtimes.
 *
 * Two things fix it, and both are needed:
 *
 * 1. **`import()` rather than `import`**, which resolves the package's
 *    `import` condition (`dist/lamejs.js`, real ESM with real exports) and is
 *    what Node's own error message recommends for loading ESM from CJS.
 * 2. **Inside a function, behind a try/catch.** This is the load-bearing
 *    half. Compression is a nicety — the audio plays perfectly uncompressed,
 *    it merely will not fit a Firestore document — so a failure to load an
 *    encoder must degrade to "not cached", never to a dead endpoint. Had the
 *    load been here in the first place, the same packaging bug would have
 *    cost a log line instead of an outage.
 *
 * Anything imported by a handler is in the blast radius of that handler. Keep
 * optional dependencies out of module scope.
 */
type Mp3EncoderCtor = new (
  channels: number,
  sampleRate: number,
  kbps: number,
) => { encodeBuffer(left: Int16Array): Uint8Array; flush(): Uint8Array };

/** Everything Gemini could hand us, as far as compression is concerned. */
export type AudioKind = 'pcm' | 'wav' | 'other';

/** `undefined` = not tried yet, `null` = tried and unavailable. */
let encoderCtor: Mp3EncoderCtor | null | undefined;

async function loadMp3Encoder(): Promise<Mp3EncoderCtor | null> {
  if (encoderCtor !== undefined) return encoderCtor;

  try {
    const mod: any = await import('@breezystack/lamejs');
    // The ESM build exports `Mp3Encoder` both named and on its default; which
    // one arrives depends on how the bundler interops the two module systems,
    // and neither is worth betting the endpoint on.
    const candidate = mod?.Mp3Encoder ?? mod?.default?.Mp3Encoder;
    encoderCtor = typeof candidate === 'function' ? candidate : null;

    if (!encoderCtor) {
      logWarn('tts_mp3_encoder_missing', 'ask-ai', {
        reason: 'module loaded without an Mp3Encoder export',
        keys: Object.keys(mod ?? {}).slice(0, 10).join(','),
      });
    }
  } catch (err: any) {
    // Cached as a permanent negative: a module that cannot resolve is a
    // packaging fact, not a blip, and retrying means re-parsing 259 KB on
    // every clip to fail the same way.
    encoderCtor = null;
    logWarn('tts_mp3_encoder_unavailable', 'ask-ai', {
      errorMessage: err?.message ?? 'unknown',
      errorCode: err?.code ?? 'unknown',
    });
  }

  // `?? null` only to narrow the sentinel away: both branches above assign,
  // so `undefined` cannot survive to here.
  return encoderCtor ?? null;
}

/** See the header — this value is chosen to avoid resampling, not to hit a size. */
const BITRATE_KBPS = 48;

/** What Gemini returns when the mimeType carries no explicit `rate=`. */
const DEFAULT_SAMPLE_RATE = 24000;

/** One MPEG Layer III granule pair; the encoder wants its input in these. */
const SAMPLES_PER_FRAME = 1152;

export const MP3_MIME = 'audio/mpeg';


/**
 * Which kind of audio this is.
 *
 * The MIME type decides when it can, and the bytes decide when it cannot: a
 * WAV is recognised by `RIFF`…`WAVE` even under a label nobody predicted.
 * `wav` is checked in the label first so that `codec=pcm` on a WAV — a shape
 * that would match a bare `pcm` test — does not get a second header wrapped
 * around it.
 */
export function detectAudioKind(mimeType: string | undefined, audioBase64?: string): AudioKind {
  const label = mimeType ?? '';
  if (/wav/i.test(label)) return 'wav';
  if (/L16|pcm/i.test(label)) return 'pcm';

  // Twelve bytes are sixteen base64 characters; no need to decode the clip.
  if (audioBase64) {
    const head = Buffer.from(audioBase64.slice(0, 16), 'base64');
    if (isRiffWave(head)) return 'wav';
  }
  return 'other';
}

/** True for the headerless PCM shapes older Gemini TTS models label their output with. */
export function isRawPcm(mimeType: string | undefined): boolean {
  return detectAudioKind(mimeType) === 'pcm';
}

function isRiffWave(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WAVE'
  );
}

/** Pull `rate=24000` out of `audio/L16;codec=pcm;rate=24000`. */
function parseSampleRate(mimeType: string | undefined): number {
  const match = /rate=(\d+)/i.exec(mimeType ?? '');
  const parsed = match ? parseInt(match[1], 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLE_RATE;
}

interface PcmAudio {
  sampleRate: number;
  channels: 1 | 2;
  /** 16-bit little-endian samples, interleaved when stereo. */
  samples: Buffer;
}

/**
 * Read the PCM out of a WAV, or null when it is anything we should not touch.
 *
 * The chunks are walked, never assumed: a header is 44 bytes only when nothing
 * sits between `fmt ` and `data`, and a `LIST` chunk often does. Only 16-bit
 * integer PCM in one or two channels is accepted; anything else is the caller's
 * to pass through unchanged, since a wrong guess here is an audible click.
 */
export function parseWav(bytes: Buffer): PcmAudio | null {
  if (!isRiffWave(bytes)) return null;

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let sawFmt = false;

  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = bytes.toString('latin1', pos, pos + 4);
    const declared = bytes.readUInt32LE(pos + 4);
    const body = pos + 8;

    if (id === 'fmt ') {
      if (declared < 16 || body + 16 > bytes.length) return null;
      format = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
      sawFmt = true;
    } else if (id === 'data') {
      if (!sawFmt) return null;
      if (format !== 1 || bits !== 16 || (channels !== 1 && channels !== 2)) return null;
      if (sampleRate < 8000 || sampleRate > 48000) return null;

      // A streamed WAV cannot know its length, so it says 0 or 0xFFFFFFFF.
      const available = bytes.length - body;
      const size = declared === 0 || declared === 0xffffffff ? available : Math.min(declared, available);
      const usable = size - (size % (channels * 2));
      if (usable <= 0) return null;

      return {
        sampleRate,
        channels: channels as 1 | 2,
        samples: bytes.subarray(body, body + usable),
      };
    }

    // Chunks are word-aligned: an odd size is followed by a padding byte.
    pos = body + declared + (declared % 2);
  }

  return null;
}

/** One mono Int16Array from interleaved 16-bit samples, averaging stereo. */
function toMono(pcm: PcmAudio): Int16Array {
  const frames = Math.floor(pcm.samples.length / (pcm.channels * 2));
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] =
      pcm.channels === 1
        ? pcm.samples.readInt16LE(i * 2)
        : Math.round((pcm.samples.readInt16LE(i * 4) + pcm.samples.readInt16LE(i * 4 + 2)) / 2);
  }
  return out;
}

/**
 * Compress base64 PCM or WAV to base64 MP3.
 *
 * Returns the input untouched when it is neither (another provider, or a
 * future model that returns a container already), when a WAV is not the plain
 * 16-bit PCM we know how to read, and when encoding fails — a compression
 * problem must never cost the listener their audio, since the bytes in hand
 * are perfectly playable as they are. The caller can tell the two apart by the
 * returned mimeType.
 */
export async function compressPcmToMp3(
  audioBase64: string,
  mimeType: string | undefined
): Promise<{ audioData: string; mimeType: string; compressed: boolean }> {
  const original = { audioData: audioBase64, mimeType: mimeType ?? 'audio/wav', compressed: false };

  const kind = detectAudioKind(mimeType, audioBase64);
  if (kind === 'other') return original;

  // Asked for before any work is done, and the one call that can fail for a
  // reason unrelated to this audio. See the note at the top of this file.
  const Mp3Encoder = await loadMp3Encoder();
  if (!Mp3Encoder) return original;

  try {
    const bytes = Buffer.from(audioBase64, 'base64');

    let samples: Int16Array;
    let sampleRate: number;

    if (kind === 'wav') {
      const wav = parseWav(bytes);
      if (!wav) {
        logWarn('tts_wav_unreadable', 'ask-ai', { mimeType: mimeType ?? 'unknown', bytes: bytes.length });
        return original;
      }
      samples = toMono(wav);
      sampleRate = wav.sampleRate;
    } else {
      sampleRate = parseSampleRate(mimeType);
      // A trailing odd byte cannot be half a sample; drop it rather than read
      // past the end of the buffer.
      const sampleCount = Math.floor(bytes.length / 2);
      samples = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i += 1) {
        samples[i] = bytes.readInt16LE(i * 2);
      }
    }

    if (samples.length === 0) return original;

    const encoder = new Mp3Encoder(1, sampleRate, BITRATE_KBPS);
    const chunks: Buffer[] = [];

    for (let offset = 0; offset < samples.length; offset += SAMPLES_PER_FRAME) {
      const frame = encoder.encodeBuffer(samples.subarray(offset, offset + SAMPLES_PER_FRAME));
      if (frame.length > 0) chunks.push(Buffer.from(frame));
    }

    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(Buffer.from(tail));

    const mp3 = Buffer.concat(chunks);
    if (mp3.length === 0) return original;

    logInfo('tts_mp3_compressed', 'ask-ai', {
      source: kind,
      sampleRate,
      bytesBefore: bytes.length,
      bytesAfter: mp3.length,
    });

    return { audioData: mp3.toString('base64'), mimeType: MP3_MIME, compressed: true };
  } catch (err: any) {
    logWarn('tts_mp3_encode_failed', 'ask-ai', {
      errorMessage: err?.message ?? 'unknown',
      mimeType: mimeType ?? 'unknown',
    });
    return original;
  }
}
