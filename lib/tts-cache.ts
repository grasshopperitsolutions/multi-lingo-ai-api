/**
 * tts-cache.ts
 *
 * A shared, permanent cache of synthesized speech, so the same sentence is
 * never paid for twice.
 *
 * Until this existed the only cache was an in-memory LRU in the browser that
 * died with the tab. Every reload re-synthesized, and since synthesis is
 * charged against the caller's daily quota like any other AI call, a twelve
 * word Word Search put twelve billable buttons on one screen — any three of
 * which exhausted an Explorer's day on audio they had already heard.
 *
 * ## The key is model, voice, style and transcript, and that is the point
 *
 * Gemini 3.8 TTS takes the text verbatim and the directions separately. The
 * frontend renders the admin-edited `tts-build-prompt` template into a
 * **style** (language, region, pace) and sends the reader's text as the
 * prompt. Hashing both, with the voice and model, gives a key that
 * distinguishes everything that changes the recording — the same sentence read
 * in pt-PT and pt-BR, or slowly and naturally, must not share a clip — and one
 * useful property that would otherwise need remembering: **editing the
 * template changes every key**. An admin who rewords the style gets fresh
 * audio everywhere instead of clips that no longer match the template that
 * supposedly produced them. Old entries are orphaned rather than overwritten,
 * which is the safe direction — nothing serves stale audio, and a sweep can
 * reclaim them later if the collection ever justifies one.
 *
 * ## What is not in here
 *
 * Only what the caller marks cacheable, which excludes anything the user
 * typed — see the `cacheable` flag in lib/types.ts. The clips are shared
 * between every user of the app, so text belonging to one of them has no
 * business in it.
 *
 * ## Why Firestore and not Cloud Storage
 *
 * Compressed (lib/mp3.ts), every realistic clip fits a document with room to
 * spare: a word is about 8 KB of base64, a story paragraph 160 KB, a full
 * minute of exam listening 470 KB. Storage would buy browser-level HTTP
 * caching of a public URL, at the price of public objects, CORS and a
 * lifecycle policy. This is the same cache-first contract the translation and
 * story pools already use, and it is inspectable in the existing admin panel.
 */

import { createHash } from 'node:crypto';
import { db, FieldValue } from './firebase-admin';
import { logInfo, logWarn } from './logger';

export const TTS_CACHE_COLLECTION = 'ttsClips';

/**
 * The ceiling on what is worth trying to store.
 *
 * Firestore's hard limit is 1 MiB for the whole document, fields and overhead
 * included. At the bitrate lib/mp3.ts encodes at this is a little over two
 * minutes of speech, far past anything the app reads aloud — so a clip that
 * trips this is a runaway prompt rather than a long passage, and skipping the
 * write is better than a throw the caller has to absorb.
 */
const MAX_AUDIO_BASE64_BYTES = 900_000;

export interface TtsCacheEntry {
  audioData: string;
  mimeType: string;
}

/**
 * Derive the cache key.
 *
 * Deliberately built from what the *provider* is asked for, not from what the
 * UI thinks it is playing: two call sites that ask for the same voice reading
 * the same rendered prompt on the same model get the same recording, however
 * differently they arrived at it.
 */
export function ttsCacheKey(input: {
  model: string;
  voice: string;
  style: string;
  prompt: string;
}): string {
  return createHash('sha256')
    .update(`${input.model}\u0000${input.voice}\u0000${input.style}\u0000${input.prompt}`)
    .digest('hex');
}

/**
 * Look up a clip. Never throws: a cache that is down is a slow app, not a
 * broken one, so a failed read degrades to a miss and pays for synthesis.
 */
export async function readTtsClip(key: string): Promise<TtsCacheEntry | null> {
  try {
    const snapshot = await db.collection(TTS_CACHE_COLLECTION).doc(key).get();
    if (!snapshot.exists) return null;

    const data = snapshot.data() ?? {};
    if (typeof data.audioData !== 'string' || data.audioData.length === 0) return null;

    return {
      audioData: data.audioData,
      mimeType: typeof data.mimeType === 'string' ? data.mimeType : 'audio/mpeg',
    };
  } catch (err: any) {
    logWarn('tts_cache_read_failed', 'ask-ai', { key, errorMessage: err?.message ?? 'unknown' });
    return null;
  }
}

/**
 * Store a clip. Never throws, for the same reason — the listener already has
 * their audio by the time this runs, and losing the cache entry costs one
 * future generation rather than this playback.
 *
 * The extra fields beside the audio exist so the collection can be read by a
 * person: a hash tells you nothing about which clip is which.
 */
export async function writeTtsClip(
  key: string,
  entry: TtsCacheEntry & {
    voice: string;
    model: string;
    style: string;
    language?: string;
    promptLength: number;
  }
): Promise<boolean> {
  if (entry.audioData.length > MAX_AUDIO_BASE64_BYTES) {
    logWarn('tts_cache_clip_too_large', 'ask-ai', {
      key,
      bytes: entry.audioData.length,
      maxBytes: MAX_AUDIO_BASE64_BYTES,
    });
    return false;
  }

  try {
    await db.collection(TTS_CACHE_COLLECTION).doc(key).set({
      audioData: entry.audioData,
      mimeType: entry.mimeType,
      voice: entry.voice,
      model: entry.model,
      // Admin-edited text rendered with a language and a pace, never user
      // data, so it is safe to keep where a person can read it.
      style: entry.style,
      language: entry.language ?? null,
      promptLength: entry.promptLength,
      bytes: entry.audioData.length,
      createdAt: FieldValue.serverTimestamp(),
    });

    logInfo('tts_cache_stored', 'ask-ai', {
      key,
      voice: entry.voice,
      model: entry.model,
      language: entry.language ?? 'unknown',
      bytes: entry.audioData.length,
    });
    return true;
  } catch (err: any) {
    logWarn('tts_cache_write_failed', 'ask-ai', { key, errorMessage: err?.message ?? 'unknown' });
    return false;
  }
}
