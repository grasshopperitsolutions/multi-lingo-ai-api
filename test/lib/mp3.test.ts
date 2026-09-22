import { describe, it, expect } from 'vitest';
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
  it('produces an MP3 several times smaller than the PCM it was given', () => {
    const pcm = pcmBase64(3);
    const out = compressPcmToMp3(pcm, PCM_MIME);

    expect(out.compressed).toBe(true);
    expect(out.mimeType).toBe(MP3_MIME);
    expect(startsWithMp3Frame(out.audioData)).toBe(true);
    // The measured ratio is about 8x; 4x is the floor that keeps a minute of
    // exam listening inside a Firestore document.
    expect(pcm.length / out.audioData.length).toBeGreaterThan(4);
  });

  it('keeps a twenty-second paragraph inside a Firestore document', () => {
    // The case that forced compression: uncompressed this is ~1.3 MB of
    // base64 against a 1 MiB ceiling.
    const out = compressPcmToMp3(pcmBase64(20), PCM_MIME);

    expect(out.compressed).toBe(true);
    expect(out.audioData.length).toBeLessThan(900_000);
  });

  it('passes a non-PCM payload straight through', () => {
    const out = compressPcmToMp3('abc', 'audio/mpeg');

    expect(out.compressed).toBe(false);
    expect(out.audioData).toBe('abc');
    expect(out.mimeType).toBe('audio/mpeg');
  });

  it('returns the original rather than nothing when the audio cannot be encoded', () => {
    // Empty, so there are no samples to encode. The listener's copy must
    // survive a compression failure — losing the audio to save space is the
    // one outcome worse than storing it uncompressed.
    const out = compressPcmToMp3('', PCM_MIME);

    expect(out.compressed).toBe(false);
    expect(out.audioData).toBe('');
  });

  it('honours the sample rate in the mimeType', () => {
    // The *same* bytes, described two ways. At a fixed bitrate an MP3's size
    // follows its duration, and the identical sample count is 1.5x longer in
    // time when it is played at 16 kHz than at 24 kHz — so a bigger file is
    // proof the declared rate was read rather than assumed.
    const pcm = pcmBase64(2, 24000);
    const at24 = compressPcmToMp3(pcm, 'audio/L16;codec=pcm;rate=24000');
    const at16 = compressPcmToMp3(pcm, 'audio/L16;codec=pcm;rate=16000');

    expect(at24.compressed).toBe(true);
    expect(at16.compressed).toBe(true);
    expect(at16.audioData.length).toBeGreaterThan(at24.audioData.length * 1.3);
  });
});
