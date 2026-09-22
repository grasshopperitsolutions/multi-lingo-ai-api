import { describe, it, expect, vi, afterEach } from 'vitest';
import { compressPcmToMp3, isRawPcm, MP3_MIME } from '../../lib/mp3';

/**
 * The compression that makes the speech cache possible at all.
 *
 * Raw PCM from Gemini is 48 KB per second, so a twenty-second paragraph is
 * past Firestore's 1 MiB document ceiling before it is even base64'd. These
 * assert the two things the rest of the system leans on: that the output is
 * an actual MP3 several times smaller, and that a clip nobody can compress
 * still comes back playable.
 */

const RATE = 24000;
const PCM_MIME = `audio/L16;codec=pcm;rate=${RATE}`;

/** Speech-ish 16-bit LE mono PCM, base64'd the way Gemini sends it. */
function pcmBase64(seconds: number, rate = RATE): string {
  const count = Math.round(rate * seconds);
  const buf = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    const t = i / rate;
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
    const sample = 12000 * envelope * (Math.sin(2 * Math.PI * 180 * t) * 0.6 + Math.sin(2 * Math.PI * 900 * t) * 0.3);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i * 2);
  }
  return buf.toString('base64');
}

/** An MP3 frame starts with eleven set bits. */
function startsWithMp3Frame(base64: string): boolean {
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

describe('isRawPcm', () => {
  it('recognises what Gemini labels its TTS output with', () => {
    expect(isRawPcm(PCM_MIME)).toBe(true);
    expect(isRawPcm('audio/L16')).toBe(true);
  });

  it('leaves an already-containered format alone', () => {
    expect(isRawPcm('audio/wav')).toBe(false);
    expect(isRawPcm('audio/mpeg')).toBe(false);
    expect(isRawPcm(undefined)).toBe(false);
  });
});

describe('compressPcmToMp3', () => {
  it('produces an MP3 several times smaller than the PCM it was given', async () => {
    const pcm = pcmBase64(3);
    const out = await compressPcmToMp3(pcm, PCM_MIME);

    expect(out.compressed).toBe(true);
    expect(out.mimeType).toBe(MP3_MIME);
    expect(startsWithMp3Frame(out.audioData)).toBe(true);
    // The measured ratio is about 8x; 4x is the floor that keeps a minute of
    // exam listening inside a Firestore document.
    expect(pcm.length / out.audioData.length).toBeGreaterThan(4);
  });

  it('keeps a twenty-second paragraph inside a Firestore document', async () => {
    // The case that forced compression: uncompressed this is ~1.3 MB of
    // base64 against a 1 MiB ceiling.
    const out = await compressPcmToMp3(pcmBase64(20), PCM_MIME);

    expect(out.compressed).toBe(true);
    expect(out.audioData.length).toBeLessThan(900_000);
  });

  it('passes a non-PCM payload straight through', async () => {
    const out = await compressPcmToMp3('abc', 'audio/mpeg');

    expect(out.compressed).toBe(false);
    expect(out.audioData).toBe('abc');
    expect(out.mimeType).toBe('audio/mpeg');
  });

  it('returns the original rather than nothing when the audio cannot be encoded', async () => {
    // Empty, so there are no samples to encode. The listener's copy must
    // survive a compression failure — losing the audio to save space is the
    // one outcome worse than storing it uncompressed.
    const out = await compressPcmToMp3('', PCM_MIME);

    expect(out.compressed).toBe(false);
    expect(out.audioData).toBe('');
  });

  it('honours the sample rate in the mimeType', async () => {
    // The *same* bytes, described two ways. At a fixed bitrate an MP3's size
    // follows its duration, and the identical sample count is 1.5x longer in
    // time when it is played at 16 kHz than at 24 kHz — so a bigger file is
    // proof the declared rate was read rather than assumed.
    const pcm = pcmBase64(2, 24000);
    const at24 = await compressPcmToMp3(pcm, 'audio/L16;codec=pcm;rate=24000');
    const at16 = await compressPcmToMp3(pcm, 'audio/L16;codec=pcm;rate=16000');

    expect(at24.compressed).toBe(true);
    expect(at16.compressed).toBe(true);
    expect(at16.audioData.length).toBeGreaterThan(at24.audioData.length * 1.3);
  });
});

/**
 * The outage guard.
 *
 * A static `import lame from '@breezystack/lamejs'` at the top of lib/mp3.ts
 * took `/api/ask-ai` down for every user: the package points its `require`
 * condition at a browser IIFE inside a `"type": "module"` package, Vercel
 * compiles these handlers to CommonJS, and Node refused the require while the
 * *module* was still loading — so the handler never ran, not even the CORS
 * preflight.
 *
 * Nothing in this suite could see it, because it is a resolution difference
 * between two runtimes: the same require succeeds on the Node that runs these
 * tests. What the suite *can* pin is the property that made it survivable —
 * that a dependency which cannot load costs a log line instead of an endpoint.
 */
describe('when the encoder cannot be loaded at all', () => {
  afterEach(() => {
    vi.doUnmock('@breezystack/lamejs');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('still imports, and hands the audio back uncompressed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    vi.doMock('@breezystack/lamejs', () => {
      throw Object.assign(
        new Error('require() of ES Module lamejs.iife.js is not supported'),
        { code: 'ERR_REQUIRE_ESM' },
      );
    });

    // Half the assertion is that this line resolves. Were the encoder still
    // loaded at module scope, importing lib/mp3 would reject here — which is
    // precisely what the deployed handler did.
    const mp3 = await import('../../lib/mp3');

    const pcm = pcmBase64(1);
    const out = await mp3.compressPcmToMp3(pcm, PCM_MIME);

    // Uncompressed audio plays perfectly; it simply will not fit a Firestore
    // document. Losing the clip — or the endpoint — to save space is the one
    // outcome worse than not caching it.
    expect(out.compressed).toBe(false);
    expect(out.audioData).toBe(pcm);
    expect(out.mimeType).toBe(PCM_MIME);
  });

  it('gives up quietly when the module loads without an encoder in it', async () => {
    // What the broken `require` condition actually produced on the Node that
    // runs these tests: an empty object, no throw, no Mp3Encoder.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    vi.doMock('@breezystack/lamejs', () => ({}));

    const mp3 = await import('../../lib/mp3');
    const out = await mp3.compressPcmToMp3(pcmBase64(1), PCM_MIME);

    expect(out.compressed).toBe(false);
  });
});
