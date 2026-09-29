import { describe, it, expect, vi, afterEach } from 'vitest';
import { compressPcmToMp3, detectAudioKind, isRawPcm, parseWav, MP3_MIME } from '../../lib/mp3';

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
 * Gemini 3.8 returns a WAV, not raw PCM. Its MIME type (`audio/wav`) matched
 * nothing the old check knew, so every clip skipped compression: responses
 * eight times larger, and anything over ~14 seconds too big to cache.
 */

interface WavOptions {
  rate?: number;
  channels?: number;
  bits?: number;
  format?: number;
  seconds?: number;
  /** Extra chunks written between `fmt ` and `data`. */
  before?: Array<{ id: string; size: number }>;
  /** What the `data` header claims; defaults to the true size. */
  declaredDataSize?: number;
  /** Cut the file to this many bytes, as a truncated download would be. */
  truncateTo?: number;
  /** Put `data` ahead of `fmt `. */
  dataFirst?: boolean;
}

/** A WAV built chunk by chunk, so each test can break exactly one thing. */
function wav(options: WavOptions = {}): Buffer {
  const { rate = RATE, channels = 1, bits = 16, format = 1, seconds = 1 } = options;
  const dataBytes = Math.round(rate * seconds) * channels * (bits / 8);

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(format, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE((rate * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);

  const extras = (options.before ?? []).map(({ id, size }) => {
    const chunk = Buffer.alloc(8 + size + (size % 2));
    chunk.write(id, 0, 'latin1');
    chunk.writeUInt32LE(size, 4);
    chunk.fill(0x41, 8, 8 + size);
    return chunk;
  });

  const data = Buffer.alloc(8 + dataBytes);
  data.write('data', 0, 'latin1');
  data.writeUInt32LE(options.declaredDataSize ?? dataBytes, 4);
  // A tone, so the encoder has something to encode; 8-bit is unsigned and
  // 16-bit signed, but the content only has to be non-silent.
  for (let i = 0; i < dataBytes / 2; i += 1) {
    data.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / rate)), 8 + i * 2);
  }

  const body = options.dataFirst
    ? [data, fmt, ...extras]
    : [fmt, ...extras, data];
  const payload = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...body]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(payload.length, 4);

  const file = Buffer.concat([header, payload]);
  return options.truncateTo ? file.subarray(0, options.truncateTo) : file;
}

const WAV_MIME = 'audio/wav';
const b64 = (buffer: Buffer) => buffer.toString('base64');

describe('detectAudioKind', () => {
  it('tells raw PCM, WAV and everything else apart by label', () => {
    expect(detectAudioKind(PCM_MIME)).toBe('pcm');
    expect(detectAudioKind('audio/wav')).toBe('wav');
    expect(detectAudioKind('audio/x-wav')).toBe('wav');
    expect(detectAudioKind('audio/wave')).toBe('wav');
    expect(detectAudioKind('audio/mpeg')).toBe('other');
    expect(detectAudioKind(undefined)).toBe('other');
  });

  it('does not take a WAV labelled with codec=pcm for headerless PCM', () => {
    // Wrapping a second header around it would play as a click in the browser.
    expect(detectAudioKind('audio/wav;codec=pcm')).toBe('wav');
    expect(isRawPcm('audio/wav;codec=pcm')).toBe(false);
  });

  it('recognises a WAV by its bytes when the label says nothing useful', () => {
    expect(detectAudioKind('application/octet-stream', b64(wav()))).toBe('wav');
    expect(detectAudioKind(undefined, b64(wav()))).toBe('wav');
  });

  it('does not mistake other bytes for a WAV', () => {
    expect(detectAudioKind('application/octet-stream', b64(Buffer.from('ID3 not a riff file')))).toBe('other');
  });
});

describe('parseWav', () => {
  it('reads a minimal 44-byte header', () => {
    const parsed = parseWav(wav({ seconds: 0.5 }));
    expect(parsed).toMatchObject({ sampleRate: 24000, channels: 1 });
    expect(parsed?.samples.length).toBe(24000);
  });

  it('finds data past a LIST chunk instead of assuming 44 bytes', () => {
    const plain = parseWav(wav({ seconds: 0.5 }));
    const withList = parseWav(wav({ seconds: 0.5, before: [{ id: 'LIST', size: 26 }] }));
    expect(withList?.samples.length).toBe(plain?.samples.length);
    // The samples are the tone, not the LIST payload (filled with 0x41).
    expect(withList?.samples.equals(plain!.samples)).toBe(true);
  });

  it('steps over the padding byte after an odd-sized chunk', () => {
    const plain = parseWav(wav({ seconds: 0.5 }));
    const odd = parseWav(wav({ seconds: 0.5, before: [{ id: 'junk', size: 7 }] }));
    expect(odd?.samples.equals(plain!.samples)).toBe(true);
  });

  it.each([0, 0xffffffff])('reads to the end of the buffer when the data size is %s', (declaredDataSize) => {
    const parsed = parseWav(wav({ seconds: 0.5, declaredDataSize }));
    expect(parsed?.samples.length).toBe(24000);
  });

  it('clamps a data size larger than the file to what is actually there', () => {
    const full = wav({ seconds: 1 });
    const parsed = parseWav(full.subarray(0, 44 + 10000));
    expect(parsed?.samples.length).toBe(10000);
  });

  it('drops a trailing half sample', () => {
    const parsed = parseWav(wav({ seconds: 0.5, declaredDataSize: 0 }).subarray(0, 44 + 1001));
    expect(parsed?.samples.length).toBe(1000);
  });

  it.each([
    ['a non-PCM format', wav({ format: 3, bits: 32 })],
    ['8-bit samples', wav({ bits: 8 })],
    ['24-bit samples', wav({ bits: 24 })],
    ['more than two channels', wav({ channels: 6 })],
    ['a sample rate out of range', wav({ rate: 96000, seconds: 0.1 })],
    ['data ahead of fmt', wav({ dataFirst: true, seconds: 0.1 })],
    ['a header cut off inside fmt', wav().subarray(0, 30)],
    ['no data chunk at all', wav().subarray(0, 36)],
    ['a data chunk with no samples', wav({ seconds: 0 })],
    ['not a RIFF file', Buffer.from('OggS this is not a wav file at all')],
  ])('refuses %s', (_label, buffer) => {
    expect(parseWav(buffer)).toBeNull();
  });
});

describe('compressPcmToMp3 — WAV', () => {
  it('compresses a WAV to an MP3 several times smaller', async () => {
    const source = b64(wav({ seconds: 3 }));
    const out = await compressPcmToMp3(source, WAV_MIME);

    expect(out.compressed).toBe(true);
    expect(out.mimeType).toBe(MP3_MIME);
    expect(startsWithMp3Frame(out.audioData)).toBe(true);
    expect(source.length / out.audioData.length).toBeGreaterThan(4);
  });

  it('keeps a twenty-second paragraph inside a Firestore document', async () => {
    // Uncompressed this is ~1.3 MB of base64 — the reason WAV must compress.
    const out = await compressPcmToMp3(b64(wav({ seconds: 20 })), WAV_MIME);

    expect(out.compressed).toBe(true);
    expect(out.audioData.length).toBeLessThan(900_000);
  });

  it('compresses a WAV whose data sits behind a LIST chunk', async () => {
    const out = await compressPcmToMp3(b64(wav({ seconds: 1, before: [{ id: 'LIST', size: 26 }] })), WAV_MIME);
    expect(out.compressed).toBe(true);
  });

  it.each([0, 0xffffffff])('compresses a WAV that declares a data size of %s', async (declaredDataSize) => {
    const out = await compressPcmToMp3(b64(wav({ seconds: 1, declaredDataSize })), WAV_MIME);
    expect(out.compressed).toBe(true);
  });

  it('compresses a truncated WAV as far as it goes', async () => {
    const out = await compressPcmToMp3(b64(wav({ seconds: 2 }).subarray(0, 44 + 20000)), WAV_MIME);
    expect(out.compressed).toBe(true);
  });

  it('compresses stereo, downmixed to mono', async () => {
    const stereo = b64(wav({ seconds: 2, channels: 2 }));
    const mono = b64(wav({ seconds: 2 }));
    const outStereo = await compressPcmToMp3(stereo, WAV_MIME);
    const outMono = await compressPcmToMp3(mono, WAV_MIME);

    expect(outStereo.compressed).toBe(true);
    // The same duration at the same bitrate: downmixing keeps it the same size
    // rather than doubling the encoder's input.
    expect(Math.abs(outStereo.audioData.length - outMono.audioData.length)).toBeLessThan(
      outMono.audioData.length * 0.1,
    );
  });

  it('takes the sample rate from the header, not the label', async () => {
    // The same sample count, described as 24 kHz and as 16 kHz: the second is
    // 1.5x longer in time, so at a fixed bitrate a bigger file is proof the
    // header's rate was read.
    const count = 48000;
    const at24 = wav({ rate: 24000, seconds: count / 24000 });
    const at16 = wav({ rate: 16000, seconds: count / 16000 });
    const out24 = await compressPcmToMp3(b64(at24), WAV_MIME);
    const out16 = await compressPcmToMp3(b64(at16), WAV_MIME);

    expect(out24.compressed).toBe(true);
    expect(out16.compressed).toBe(true);
    expect(out16.audioData.length).toBeGreaterThan(out24.audioData.length * 1.3);
  });

  it('compresses a WAV under a label nobody predicted, by its bytes', async () => {
    const out = await compressPcmToMp3(b64(wav()), 'application/octet-stream');
    expect(out.compressed).toBe(true);
  });

  it('does not wrap a second header around a WAV labelled codec=pcm', async () => {
    const out = await compressPcmToMp3(b64(wav({ seconds: 1 })), 'audio/wav;codec=pcm;rate=24000');

    expect(out.compressed).toBe(true);
    expect(startsWithMp3Frame(out.audioData)).toBe(true);
  });

  it.each([
    ['a non-PCM format', wav({ format: 3, bits: 32 })],
    ['8-bit samples', wav({ bits: 8 })],
    ['a header cut off inside fmt', wav().subarray(0, 30)],
    ['a data chunk with no samples', wav({ seconds: 0 })],
    ['data ahead of fmt', wav({ dataFirst: true, seconds: 0.1 })],
  ])('hands back the original untouched for %s', async (_label, buffer) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = b64(buffer);
    const out = await compressPcmToMp3(source, WAV_MIME);

    expect(out.compressed).toBe(false);
    expect(out.audioData).toBe(source);
    expect(out.mimeType).toBe(WAV_MIME);
    vi.restoreAllMocks();
  });

  it('leaves raw PCM compressing as before', async () => {
    const out = await compressPcmToMp3(pcmBase64(2), PCM_MIME);
    expect(out.compressed).toBe(true);
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
