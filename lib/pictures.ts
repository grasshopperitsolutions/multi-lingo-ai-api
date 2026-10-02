/**
 * pictures.ts
 *
 * One picture per word, drawn once, on the server, and shared by every player
 * and every language. This is the `picture` mode of /api/ask-ai (not an
 * endpoint of its own), and it is the only code that asks Gemini to draw.
 *
 * ## Why it lives here and not in the browser
 *
 * The icon service builds its prompt in the browser and writes the result from
 * the browser, which is fine for an SVG that is sanitised on render. It is not
 * fine for a picture every player sees:
 *
 * - **Anyone could plant one.** `wordPool` is writable by any signed-in
 *   account, guests included. A browser-built flow would let anyone put any
 *   image, from any prompt or URL, on "gato" for everybody.
 * - **Phones would download originals.** A generated PNG is 1–2 MB and the API
 *   cannot return a compressed format, so a four-picture round would be 6 MB.
 *   Something has to shrink it, and that something is `sharp`, here.
 *
 * So the request names a **concept**, never a prompt. Every prompt is rendered
 * here from an admin-edited template and the concept's own `sourceWord`, and
 * the result is written to a collection only the Admin SDK can write
 * (`conceptPictures`, `pictureScenes`: `write: 'admin'` in
 * collection-policies.ts, which the server's own writes bypass).
 *
 * ## Who pays
 *
 * Pictures do **not** spend the daily AI allowance: being shown decoration you
 * did not ask for should not cost you a call, and an Explorer's three a day
 * would not survive one round. The spend is bounded instead by:
 *
 * - one picture per word, ever (the cache check comes first, before anything
 *   is charged or counted),
 * - a per-account cap on new pictures a day (`PICTURE_DAILY_CAP`),
 * - guests never making one, and
 * - the server building the prompt, so the request cannot ask for more than
 *   "draw this concept".
 *
 * ## The life of a word
 *
 *     (none) ──claim──▶ pending ──▶ ready
 *                          │──────▶ skipped   (cannot be one clear picture)
 *                          │──────▶ failed    (the model declined; retried after 7 days)
 *                          └──────▶ (none)    (a provider fault; nothing is recorded)
 *
 * A fault in the service releases the claim rather than marking the word:
 * "the model said no" is a fact about the word and is remembered, "the service
 * is down" or "the model id is wrong" is not, and recording the second as the
 * first would blacklist a whole pool for a week over a typo in Admin.
 */

import { createHash, randomUUID } from 'node:crypto';
import { db, storage, FieldValue } from './firebase-admin';
import { askGemini, generateGeminiImage } from './providers/gemini';
import { bump, safeKey, type Increment } from './pulse';
import { reportMessage } from './sentry';
import { logInfo, logWarn, logError } from './logger';
import type { PictureRequest } from './types';

// ── Names and limits ────────────────────────────────────────────────────────

export const PICTURES_COLLECTION = 'conceptPictures';
export const SCENES_COLLECTION = 'pictureScenes';
/** One document per (picture, reporter), so an account counts once. */
export const PICTURE_REPORTS_COLLECTION = 'pictureReports';

/** New pictures one account may cause in a day. Past it the request is refused, not charged. */
export const PICTURE_DAILY_CAP = 30;
/** New scenes one account may cause in a day. Scenes are for unlimited tiers only. */
export const SCENE_DAILY_CAP = 10;
/** A claim older than this is treated as abandoned (a function that died mid-draw). */
export const CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
/** A word the model declined is left alone this long before it is tried again. */
export const FAILED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

export const SCENE_MIN_CONCEPTS = 4;
export const SCENE_MAX_CONCEPTS = 6;

/** A word picture is a square sticker; a scene is a landscape. */
const WORD_PICTURE = { aspectRatio: '1:1', imageSize: '1K', width: 512, height: 512 } as const;
const SCENE_PICTURE = { aspectRatio: '4:3', imageSize: '1K', width: 1024, height: 768 } as const;
const WEBP_QUALITY = 80;
/** Public, one year, immutable: the file name carries a hash, so a new picture is a new URL. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * The prompt documents this reads, in `appConfig/config/prompts`. The model id
 * lives on each document, like every other feature; the constants below are
 * only the fallback for a document that names none.
 */
export const PICTURE_PROMPT_IDS = {
  picturable: 'concept-picturable-prompt',
  picture: 'concept-picture-prompt',
  scene: 'picture-scene-prompt',
} as const;

const FALLBACK_PICTURABLE_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_PICTURE_MODEL = 'gemini-3.1-flash-lite-image';
const FALLBACK_SCENE_MODEL = 'gemini-3.1-flash-image';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A source word reaches a prompt, so it is checked first. `wordPool` is
 * writable by any signed-in account, which makes `sourceWord` user-controlled
 * text — and a picture, once drawn, is permanent and shared. Letters, spaces,
 * hyphens and apostrophes only, short: "ice cream", "t-shirt" and "o'clock"
 * pass, a sentence does not.
 */
const SOURCE_WORD_PATTERN = /^[\p{L}][\p{L}\p{M}' -]{0,39}$/u;
const SENSE_KEY_PATTERN = /^[A-Za-z0-9_ -]{1,40}$/;
const KNOWN_POS = new Set(['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'interjection']);

// ── Types ───────────────────────────────────────────────────────────────────

/** What a caller gets back about one word's picture. */
export interface PictureView {
  conceptId: string;
  /** `ready` has a `url`; `pending` means someone else is drawing it now. */
  status: 'ready' | 'pending' | 'skipped' | 'failed';
  url?: string;
  width?: number;
  height?: number;
}

export interface SceneView {
  sceneId: string;
  url: string;
  conceptIds: string[];
  topicId: string | null;
  width: number;
  height: number;
}

export type PictureResult =
  | { ok: true; picture: PictureView | SceneView | { conceptId: string; reported: boolean } }
  | { ok: false; status: number; error: string; code: string };

export interface PictureCaller {
  uid: string;
  /** True for a Firebase anonymous session: a throwaway account, never a person. */
  isAnonymous: boolean;
  /** The real subscription, not the quota tier (limits paused pin that to explorer). */
  tier: string;
  /** Whether this tier has no daily AI allowance. Scenes are for these only. */
  unlimited: boolean;
  /** The user's profile as read at the top of the request, for the cap report. */
  userData: Record<string, any>;
}

interface PromptDoc {
  template: string;
  model: string;
}

// ── Small helpers ───────────────────────────────────────────────────────────

const refuse = (status: number, code: string, error: string): PictureResult => ({
  ok: false,
  status,
  code,
  error,
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** `{{name}}` substitution, the same rule as the frontend's renderTemplate. */
function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match
  );
}

/** A provider-style error the ask-ai handler already knows how to answer. */
function configError(message: string): Error {
  return Object.assign(new Error(message), { status: 500 });
}

/**
 * Read a prompt document straight from Firestore. The API already reads this
 * collection for the Pulse labels; the frontend is the other reader.
 *
 * Throws when the document is missing, has no template, or its template
 * lacks the placeholder the picture is about. That last check is the one that
 * matters: a picture is paid once and kept for ever, so a template edited
 * into something that no longer says *what to draw* must stop here, not fill
 * the pool with unrelated art that every player then sees.
 */
async function readPrompt(id: string, fallbackModel: string, mustContain: string): Promise<PromptDoc> {
  const snap = await db.collection('appConfig').doc('config').collection('prompts').doc(id).get();
  const data = snap.exists ? snap.data() : undefined;
  const template = typeof data?.template === 'string' ? data.template : '';
  if (!template.trim()) {
    throw configError(`Prompt "${id}" is missing or empty`);
  }
  if (!template.includes(`{{${mustContain}}}`)) {
    throw configError(`Prompt "${id}" has no {{${mustContain}}} placeholder`);
  }
  const model = typeof data?.model === 'string' && data.model.trim() ? data.model.trim() : fallbackModel;
  return { template, model };
}

/** The values a concept contributes to a prompt. Always defined, never raw. */
function conceptVariables(concept: Record<string, any>): { sourceWord: string; senseKey: string; pos: string } | null {
  const sourceWord = String(concept.sourceWord ?? '').trim();
  if (!SOURCE_WORD_PATTERN.test(sourceWord)) return null;
  const senseKey = String(concept.senseKey ?? '').trim();
  const pos = String(concept.pos ?? '').trim().toLowerCase();
  return {
    sourceWord,
    senseKey: SENSE_KEY_PATTERN.test(senseKey) ? senseKey : 'none',
    pos: KNOWN_POS.has(pos) ? pos : 'none',
  };
}

// ── sharp, loaded lazily ────────────────────────────────────────────────────
//
// Imported inside a function, behind a try/catch, for the same reason mp3.ts
// loads its encoder that way: anything imported at module scope is in the
// blast radius of the handler that imports it, and a native package that fails
// to load must cost one picture request, not every AI feature in the app.
// (Two ERR_REQUIRE_ESM outages are written up in CLAUDE.md.)

type SharpFactory = (input: Buffer) => any;
let sharpLoader: () => Promise<SharpFactory | null> = async () => {
  try {
    const mod: any = await import('sharp');
    return (mod.default ?? mod) as SharpFactory;
  } catch (err: any) {
    logWarn('sharp_unavailable', 'ask-ai', { errorMessage: err?.message ?? 'unknown' });
    return null;
  }
};

/** Test seam: replace how `sharp` is loaded. */
export function __setSharpLoader(loader: () => Promise<SharpFactory | null>): void {
  sharpLoader = loader;
}

/**
 * Shrink the API's PNG to a small WebP. Throws when `sharp` cannot be loaded:
 * storing the 1–2 MB original instead would defeat the point of doing this on
 * the server at all, so the picture request fails and the word stays unpictured.
 */
async function shrinkToWebp(
  base64: string,
  width: number,
  height: number
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const sharp = await sharpLoader();
  if (!sharp) throw configError('Image encoder is unavailable');

  const { data, info } = await sharp(Buffer.from(base64, 'base64'))
    .resize({ width, height, fit: 'cover' })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });

  return { buffer: data, width: info.width ?? width, height: info.height ?? height };
}

/** Upload a public, immutable WebP and return where it lives. */
async function uploadWebp(folder: string, buffer: Buffer): Promise<{ path: string; url: string }> {
  const bucket = storage.bucket();
  // The hash is in the name, so a regenerated picture is a new URL and no
  // phone keeps showing the old one.
  const path = `${folder}/${sha256(buffer).slice(0, 16)}.webp`;
  await bucket.file(path).save(buffer, {
    contentType: 'image/webp',
    resumable: false,
    public: true,
    metadata: { cacheControl: CACHE_CONTROL },
  });
  return { path, url: `https://storage.googleapis.com/${bucket.name}/${path}` };
}

/** Delete a stored file, quietly: an orphan costs pennies, a thrown error costs the request. */
async function deleteFile(path: unknown): Promise<void> {
  if (typeof path !== 'string' || !path) return;
  try {
    await storage.bucket().file(path).delete();
  } catch (err: any) {
    logWarn('picture_file_delete_failed', 'ask-ai', { path, errorMessage: err?.message ?? 'unknown' });
  }
}

// ── What a stored document means ────────────────────────────────────────────

type Standing = 'ready' | 'pending' | 'skipped' | 'failed' | 'free';

/** Whether a stored picture document settles the question or leaves the word to be drawn. */
export function standingOf(existing: Record<string, any> | undefined, now: number): Standing {
  if (!existing) return 'free';
  switch (existing.status) {
    case 'ready':
      return typeof existing.url === 'string' && existing.url ? 'ready' : 'free';
    case 'skipped':
      return 'skipped';
    case 'pending':
      // A claim nobody finished is abandoned, not a reason to wait for ever.
      return now - Number(existing.claimedAt ?? 0) < CLAIM_TIMEOUT_MS ? 'pending' : 'free';
    case 'failed':
      return now - Number(existing.failedAt ?? 0) < FAILED_RETRY_MS ? 'failed' : 'free';
    default:
      return 'free';
  }
}

/**
 * Whether somebody is drawing this word right now: a claim that is still
 * fresh. Looked at beside the status because an admin's regenerate leaves the
 * old picture `ready` (and on show) while the new one is drawn.
 */
function claimInProgress(existing: Record<string, any> | undefined, now: number): boolean {
  return Boolean(existing?.claimId) && now - Number(existing?.claimedAt ?? 0) < CLAIM_TIMEOUT_MS;
}

function viewOf(conceptId: string, existing: Record<string, any>, standing: Standing): PictureView {
  if (standing === 'ready') {
    return { conceptId, status: 'ready', url: existing.url, width: existing.width, height: existing.height };
  }
  return { conceptId, status: standing as 'pending' | 'skipped' | 'failed' };
}

// ── Claiming a word ─────────────────────────────────────────────────────────

type ClaimOutcome =
  | { kind: 'claimed'; claimId: string; previous?: Record<string, any> }
  | { kind: 'existing'; view: PictureView }
  | { kind: 'capped' };

/**
 * Take the right to draw one word, and count it against the account's cap, in
 * one transaction. Two players opening the same word at once both come here;
 * one claims it and the other is told it is being drawn, so nobody pays twice.
 *
 * `force` is the admin's regenerate: it ignores a finished picture, but never
 * a draw that is in progress, and it does not spend the admin's own cap.
 */
async function claimWord(
  conceptId: string,
  uid: string,
  sourceWord: string,
  { force = false }: { force?: boolean } = {}
): Promise<ClaimOutcome> {
  const picRef = db.collection(PICTURES_COLLECTION).doc(conceptId);
  const userRef = db.collection('users').doc(uid);
  const day = today();
  const now = Date.now();

  return db.runTransaction(async (tx: any) => {
    const [picSnap, userSnap] = await Promise.all([tx.get(picRef), tx.get(userRef)]);
    const existing = picSnap.exists ? picSnap.data() : undefined;
    const standing = standingOf(existing, now);

    if (claimInProgress(existing, now) || (!force && standing !== 'free')) {
      return { kind: 'existing', view: viewOf(conceptId, existing ?? {}, standing) } as ClaimOutcome;
    }

    if (!force) {
      const user = userSnap.exists ? userSnap.data() ?? {} : {};
      const used: number = user.picturesDate === day ? (user.picturesToday ?? 0) : 0;
      if (used >= PICTURE_DAILY_CAP) return { kind: 'capped' } as ClaimOutcome;
      tx.set(userRef, { picturesToday: used + 1, picturesDate: day }, { merge: true });
    }

    const claimId = randomUUID();
    if (force && standing === 'ready') {
      // Redrawing a picture that is on show: keep it on show until the new one
      // is stored, rather than taking it out of every game for the duration.
      tx.set(picRef, { claimId, claimedAt: now }, { merge: true });
    } else {
      tx.set(picRef, { conceptId, sourceWord, status: 'pending', claimId, claimedAt: now });
    }
    return { kind: 'claimed', claimId, previous: existing } as ClaimOutcome;
  });
}

/** Write the outcome, but only if the claim is still ours. */
async function finish(conceptId: string, claimId: string, data: Record<string, unknown>): Promise<boolean> {
  const picRef = db.collection(PICTURES_COLLECTION).doc(conceptId);
  return db.runTransaction(async (tx: any) => {
    const snap = await tx.get(picRef);
    if (!snap.exists || snap.data()?.claimId !== claimId) return false;
    tx.set(picRef, { conceptId, ...data });
    return true;
  });
}

/** Give a claim back after a fault, so the word is simply unpictured again. */
async function release(conceptId: string, claimId: string, previous?: Record<string, any>): Promise<void> {
  const picRef = db.collection(PICTURES_COLLECTION).doc(conceptId);
  try {
    await db.runTransaction(async (tx: any) => {
      const snap = await tx.get(picRef);
      if (!snap.exists || snap.data()?.claimId !== claimId) return;
      // A regenerate that failed must not take a good picture away.
      if (previous && previous.status === 'ready') tx.set(picRef, previous);
      else tx.delete(picRef);
    });
  } catch (err: any) {
    logWarn('picture_release_failed', 'ask-ai', { conceptId, errorMessage: err?.message ?? 'unknown' });
  }
}

// ── Counting what was spent ─────────────────────────────────────────────────

type Tokens = { input: number; output: number; thinking: number } | undefined;

function tokenIncrements(promptId: string, tier: string, model: string, tokens: Tokens): Increment[] {
  const feature = safeKey(promptId);
  const pulseTier = safeKey(tier);
  const modelKey = safeKey(model);
  return [
    [['ai', feature, pulseTier, 'calls'], 1],
    [['ai', feature, pulseTier, 'inputTokens'], tokens?.input ?? 0],
    [['ai', feature, pulseTier, 'outputTokens'], tokens?.output ?? 0],
    [['models', modelKey, 'calls'], 1],
    [['models', modelKey, 'inputTokens'], tokens?.input ?? 0],
    [['models', modelKey, 'outputTokens'], tokens?.output ?? 0],
  ];
}

/**
 * Reaching a cap is either a frontend bug or someone farming the free
 * exemption, so, like the maintenance cap in ask-ai.ts, an admin hears about it:
 * an error to the logs and Sentry, and a report in Admin › Reports (which the
 * nightly digest emails while it is unread). Once per account per day. Never
 * throws: failing to report must not fail the request.
 */
async function reportCap(caller: PictureCaller, kind: 'pictures' | 'scenes', cap: number): Promise<void> {
  const day = today();
  if (caller.userData.pictureCapReportedDate === day) return;
  try {
    await reportMessage(
      'picture_cap_reached',
      'ask-ai',
      `User ${caller.uid} reached the daily cap of ${cap} new ${kind}`,
      { uid: caller.uid, kind, cap }
    );
    await db.collection('appConfig').doc('config').collection('reports').add({
      category: 'Bug / Error',
      message:
        `This user asked for more than ${cap} new ${kind} today. Real play never comes close, ` +
        `so this is either a bug in the picture games or the free exemption being misused. ` +
        `Further requests today are refused, not charged.`,
      context: 'api/ask-ai — picture cap',
      reporterUid: caller.uid,
      reporterEmail: caller.userData.email ?? null,
      reporterName: caller.userData.displayName ?? null,
      source: 'server',
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    await db.collection('users').doc(caller.uid).set({ pictureCapReportedDate: day }, { merge: true });
  } catch (err: any) {
    logError('picture_cap_report_failed', 'ask-ai', { uid: caller.uid, errorMessage: err?.message ?? 'unknown' });
  }
}

// ── The word picture ────────────────────────────────────────────────────────

/**
 * Ask whether a word could be one clear picture of one concrete thing.
 *
 * "Freedom" and "to remember" cannot, and neither can a word easily mistaken
 * for a more common one with the same picture ("mug" for "cup"). One cheap
 * text call; the answer is stored as `picturable`.
 */
async function askPicturable(
  prompt: PromptDoc,
  vars: { sourceWord: string; senseKey: string; pos: string }
): Promise<{ picturable: boolean; tokens: Tokens; model: string }> {
  const result = await askGemini(renderTemplate(prompt.template, vars), {
    provider: 'gemini',
    model: prompt.model,
    temperature: 0,
    maxOutputTokens: 256,
    jsonMode: true,
    responseSchema: {
      type: 'object',
      properties: { picturable: { type: 'boolean' } },
      required: ['picturable'],
    },
  });

  let parsed: any;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw Object.assign(new Error('Picturable check returned no usable answer'), { status: 502 });
  }
  if (typeof parsed?.picturable !== 'boolean') {
    throw Object.assign(new Error('Picturable check returned no usable answer'), { status: 502 });
  }
  return { picturable: parsed.picturable, tokens: result.tokens, model: result.model ?? prompt.model };
}

/** The shared tail of "draw it" for a first picture and for an admin's regenerate. */
async function drawAndStore(args: {
  caller: PictureCaller;
  conceptId: string;
  vars: { sourceWord: string; senseKey: string; pos: string };
  pictureStart: PromptDoc;
  picturablePrompt: PromptDoc | null;
  claim: { claimId: string; previous?: Record<string, any> };
}): Promise<PictureResult> {
  const { caller, conceptId, vars, pictureStart, picturablePrompt, claim } = args;
  const increments: Increment[] = [];

  try {
    // 1. Can it be drawn? (Skipped on a regenerate: that word already is.)
    if (picturablePrompt) {
      const verdict = await askPicturable(picturablePrompt, vars);
      increments.push(...tokenIncrements(PICTURE_PROMPT_IDS.picturable, caller.tier, verdict.model, verdict.tokens));

      if (!verdict.picturable) {
        await finish(conceptId, claim.claimId, {
          sourceWord: vars.sourceWord,
          status: 'skipped',
          picturable: false,
          createdAt: FieldValue.serverTimestamp(),
        });
        increments.push([['pictures', 'skipped'], 1]);
        logInfo('picture_skipped', 'ask-ai', { uid: caller.uid, conceptId });
        await bump(increments);
        return { ok: true, picture: { conceptId, status: 'skipped' } };
      }
    }

    // 2. Draw it, from a prompt this module rendered and nothing else.
    const prompt = renderTemplate(pictureStart.template, vars);
    const drawn = await generateGeminiImage(prompt, {
      model: pictureStart.model,
      aspectRatio: WORD_PICTURE.aspectRatio,
      imageSize: WORD_PICTURE.imageSize,
    });
    increments.push(...tokenIncrements(PICTURE_PROMPT_IDS.picture, caller.tier, drawn.model, drawn.tokens));

    // The model declining is a fact about the word: remember it, and leave it
    // alone for a week rather than retrying in a loop.
    if (drawn.kind === 'blocked') {
      await finish(conceptId, claim.claimId, {
        sourceWord: vars.sourceWord,
        status: 'failed',
        failedAt: Date.now(),
        failedReason: drawn.reason,
        picturable: true,
        model: drawn.model,
        createdAt: FieldValue.serverTimestamp(),
      });
      increments.push([['pictures', 'failed'], 1]);
      logWarn('picture_failed', 'ask-ai', { uid: caller.uid, conceptId, reason: drawn.reason });
      await bump(increments);
      return { ok: true, picture: { conceptId, status: 'failed' } };
    }

    // 3. Shrink, 4. store.
    const shrunk = await shrinkToWebp(drawn.imageData, WORD_PICTURE.width, WORD_PICTURE.height);
    const stored = await uploadWebp(`${PICTURES_COLLECTION}/${conceptId}`, shrunk.buffer);

    // 5. Record it, if the claim is still ours.
    const written = await finish(conceptId, claim.claimId, {
      sourceWord: vars.sourceWord,
      status: 'ready',
      url: stored.url,
      path: stored.path,
      model: drawn.model,
      promptHash: sha256(prompt),
      picturable: true,
      width: shrunk.width,
      height: shrunk.height,
      bytes: shrunk.buffer.length,
      reports: 0,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (!written) {
      // Our claim timed out and another request took the word over while this
      // one was still drawing. Theirs wins; this file is the orphan.
      logWarn('picture_claim_lost', 'ask-ai', { conceptId });
      await deleteFile(stored.path);
      await bump(increments);
      return { ok: true, picture: { conceptId, status: 'pending' } };
    }

    increments.push([['pictures', 'generated'], 1]);
    logInfo('picture_generated', 'ask-ai', {
      uid: caller.uid,
      conceptId,
      model: drawn.model,
      bytes: shrunk.buffer.length,
    });
    await bump(increments);

    return { ok: true, picture: { conceptId, status: 'ready', url: stored.url, width: shrunk.width, height: shrunk.height } };
  } catch (err) {
    // A fault in the service says nothing about the word.
    await release(conceptId, claim.claimId, claim.previous);
    await bump(increments);
    throw err;
  }
}

/**
 * The picture for one word: what exists, or drawn once.
 *
 * Order matters and is the cost control:
 * 1. return what exists, before anything is charged or counted;
 * 2. refuse guests and unknown words;
 * 3. claim the word and count it, in one transaction;
 * 4. only then ask the model anything.
 */
async function pictureForWord(caller: PictureCaller, conceptId: string, mode: 'word' | 'regenerate'): Promise<PictureResult> {
  const isRegenerate = mode === 'regenerate';
  const now = Date.now();

  // 1. What exists. A regenerate is the one request that wants the word drawn
  // again, so it skips the lookup.
  if (!isRegenerate) {
    const existingSnap = await db.collection(PICTURES_COLLECTION).doc(conceptId).get();
    const existing = existingSnap.exists ? existingSnap.data() : undefined;
    const standing = standingOf(existing, now);
    if (existing && standing !== 'free') {
      logInfo('picture_served', 'ask-ai', { uid: caller.uid, conceptId, status: standing });
      return { ok: true, picture: viewOf(conceptId, existing, standing) };
    }
  }

  // 2. Only a signed-in person causes a new picture.
  if (caller.isAnonymous) {
    return refuse(403, 'PICTURE_GUEST', 'Sign in to add pictures');
  }

  const conceptSnap = await db.collection('wordPool').doc(conceptId).get();
  const concept = conceptSnap.exists ? conceptSnap.data() : undefined;
  if (!concept || concept.status !== 'ready') {
    return refuse(404, 'PICTURE_NO_WORD', 'That word is not available');
  }
  const vars = conceptVariables(concept);
  if (!vars) {
    // Not a word a picture can be asked for. Nothing is stored: it costs two
    // reads to say so again, and a stored verdict would be about text a
    // signed-in stranger wrote.
    return { ok: true, picture: { conceptId, status: 'skipped' } };
  }

  // Both prompts are read before the claim, so a missing or broken template
  // costs nothing and holds nothing.
  const pictureStart = await readPrompt(PICTURE_PROMPT_IDS.picture, FALLBACK_PICTURE_MODEL, 'sourceWord');
  const picturablePrompt = isRegenerate
    ? null
    : await readPrompt(PICTURE_PROMPT_IDS.picturable, FALLBACK_PICTURABLE_MODEL, 'sourceWord');

  // 3. Claim and count.
  const outcome = await claimWord(conceptId, caller.uid, vars.sourceWord, { force: isRegenerate });
  if (outcome.kind === 'existing') {
    return { ok: true, picture: outcome.view };
  }
  if (outcome.kind === 'capped') {
    await bump([[['pictures', 'capped'], 1]]);
    await reportCap(caller, 'pictures', PICTURE_DAILY_CAP);
    return refuse(429, 'PICTURE_CAP', 'Daily picture limit reached');
  }

  // 4. Ask the model.
  const result = await drawAndStore({
    caller,
    conceptId,
    vars,
    pictureStart,
    picturablePrompt,
    claim: { claimId: outcome.claimId, previous: outcome.previous },
  });

  // A regenerate replaced the picture: the old file and the reports about it
  // belong to a picture that is gone.
  if (isRegenerate && result.ok && (result.picture as PictureView).status === 'ready') {
    await deleteFile(outcome.previous?.path);
    await clearReports(conceptId);
  }
  return result;
}

// ── Reports ─────────────────────────────────────────────────────────────────

/**
 * "This picture does not match its word." Adds one to `reports` on the picture,
 * once per account.
 *
 * The one-per-account part is a document per (picture, reporter) in a
 * collection only an admin can read, not a list on the picture: the picture is
 * readable by every player, and the reporters are nobody's business.
 */
async function reportPicture(caller: PictureCaller, conceptId: string): Promise<PictureResult> {
  if (caller.isAnonymous) {
    return refuse(403, 'PICTURE_GUEST', 'Sign in to report a picture');
  }

  const picRef = db.collection(PICTURES_COLLECTION).doc(conceptId);
  const reporterRef = db.collection(PICTURE_REPORTS_COLLECTION).doc(`${conceptId}__${caller.uid}`);

  const outcome: 'missing' | 'counted' | 'repeat' = await db.runTransaction(async (tx: any) => {
    const [picSnap, reporterSnap] = await Promise.all([tx.get(picRef), tx.get(reporterRef)]);
    if (!picSnap.exists || picSnap.data()?.status !== 'ready') return 'missing';
    if (reporterSnap.exists) return 'repeat';
    tx.set(reporterRef, { conceptId, createdAt: FieldValue.serverTimestamp() });
    tx.set(picRef, { reports: FieldValue.increment(1) }, { merge: true });
    return 'counted';
  });

  if (outcome === 'missing') return refuse(404, 'PICTURE_NONE', 'That picture does not exist');
  if (outcome === 'counted') await bump([[['pictures', 'reports'], 1]]);
  return { ok: true, picture: { conceptId, reported: outcome === 'counted' } };
}

/** Forget who reported a picture that has just been replaced, so the new one can be reported afresh. */
async function clearReports(conceptId: string): Promise<void> {
  try {
    const snap = await db.collection(PICTURE_REPORTS_COLLECTION).where('conceptId', '==', conceptId).get();
    for (const doc of snap.docs) await doc.ref.delete();
  } catch (err: any) {
    logWarn('picture_reports_clear_failed', 'ask-ai', { conceptId, errorMessage: err?.message ?? 'unknown' });
  }
}

// ── Scenes ──────────────────────────────────────────────────────────────────

/**
 * One cheerful everyday scene with 4–6 pictured words in it, for the
 * "Describe the picture" game.
 *
 * The request names concept ids and nothing else. Every one must already have a
 * picture (so each is known to be drawable), and the words in the prompt come
 * from the concept documents. Unlimited tiers only, because a scene is a
 * pricier model and the allowance cannot meter it; ten a day.
 */
async function drawScene(caller: PictureCaller, rawIds: unknown): Promise<PictureResult> {
  if (caller.isAnonymous) {
    return refuse(403, 'PICTURE_GUEST', 'Sign in to add pictures');
  }
  if (!caller.unlimited) {
    return refuse(403, 'SCENE_TIER', 'Your plan cannot create new scenes');
  }

  if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'string' || !ID_PATTERN.test(id))) {
    return refuse(400, 'SCENE_BAD_REQUEST', 'A scene needs a list of concept ids');
  }
  const conceptIds = [...new Set(rawIds as string[])];
  if (conceptIds.length < SCENE_MIN_CONCEPTS || conceptIds.length > SCENE_MAX_CONCEPTS) {
    return refuse(400, 'SCENE_BAD_REQUEST', `A scene needs ${SCENE_MIN_CONCEPTS} to ${SCENE_MAX_CONCEPTS} words`);
  }

  // Every word must be one that already has a picture, and its text must be
  // something that can go into a prompt.
  const words: string[] = [];
  const topicLists: string[][] = [];
  for (const conceptId of conceptIds) {
    const [conceptSnap, picSnap] = await Promise.all([
      db.collection('wordPool').doc(conceptId).get(),
      db.collection(PICTURES_COLLECTION).doc(conceptId).get(),
    ]);
    const concept = conceptSnap.exists ? conceptSnap.data() : undefined;
    const vars = concept && concept.status === 'ready' ? conceptVariables(concept) : null;
    if (!vars || !picSnap.exists || picSnap.data()?.status !== 'ready') {
      return refuse(400, 'SCENE_BAD_WORD', 'Every word in a scene needs a picture');
    }
    words.push(vars.sourceWord);
    topicLists.push(Array.isArray(concept!.topicIds) ? concept!.topicIds.filter((t: unknown) => typeof t === 'string') : []);
  }

  const scenePrompt = await readPrompt(PICTURE_PROMPT_IDS.scene, FALLBACK_SCENE_MODEL, 'sourceWords');

  // Count it. A scene is charged to the cap whether or not the model draws it:
  // the call is what costs.
  const day = today();
  const userRef = db.collection('users').doc(caller.uid);
  const allowed: boolean = await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(userRef);
    const user = snap.exists ? snap.data() ?? {} : {};
    const used: number = user.scenesDate === day ? (user.scenesToday ?? 0) : 0;
    if (used >= SCENE_DAILY_CAP) return false;
    tx.set(userRef, { scenesToday: used + 1, scenesDate: day }, { merge: true });
    return true;
  });
  if (!allowed) {
    await bump([[['pictures', 'capped'], 1]]);
    await reportCap(caller, 'scenes', SCENE_DAILY_CAP);
    return refuse(429, 'PICTURE_CAP', 'Daily scene limit reached');
  }

  const prompt = renderTemplate(scenePrompt.template, { sourceWords: words.join(', ') });
  const increments: Increment[] = [];
  const drawn = await generateGeminiImage(prompt, {
    model: scenePrompt.model,
    aspectRatio: SCENE_PICTURE.aspectRatio,
    imageSize: SCENE_PICTURE.imageSize,
  });
  increments.push(...tokenIncrements(PICTURE_PROMPT_IDS.scene, caller.tier, drawn.model, drawn.tokens));

  if (drawn.kind === 'blocked') {
    increments.push([['pictures', 'failed'], 1]);
    await bump(increments);
    logWarn('scene_blocked', 'ask-ai', { uid: caller.uid, reason: drawn.reason });
    return refuse(422, 'SCENE_BLOCKED', 'That scene could not be drawn');
  }

  const shrunk = await shrinkToWebp(drawn.imageData, SCENE_PICTURE.width, SCENE_PICTURE.height);
  const sceneRef = db.collection(SCENES_COLLECTION).doc();
  const stored = await uploadWebp(`${SCENES_COLLECTION}/${sceneRef.id}`, shrunk.buffer);

  // A topic every one of the words shares, or none. Worked out here from the
  // concept documents so the request never has to name one.
  const sharedTopic = topicLists.reduce<string[]>(
    (shared, topics) => shared.filter((id) => topics.includes(id)),
    topicLists[0] ?? []
  )[0] ?? null;

  await sceneRef.set({
    status: 'ready',
    url: stored.url,
    path: stored.path,
    conceptIds,
    sourceWords: words,
    topicId: sharedTopic,
    model: drawn.model,
    promptHash: sha256(prompt),
    width: shrunk.width,
    height: shrunk.height,
    bytes: shrunk.buffer.length,
    createdAt: FieldValue.serverTimestamp(),
  });

  increments.push([['pictures', 'scenes'], 1]);
  await bump(increments);
  logInfo('scene_generated', 'ask-ai', { uid: caller.uid, sceneId: sceneRef.id, bytes: shrunk.buffer.length });

  return {
    ok: true,
    picture: {
      sceneId: sceneRef.id,
      url: stored.url,
      conceptIds,
      topicId: sharedTopic,
      width: shrunk.width,
      height: shrunk.height,
    },
  };
}

/**
 * A stored scene's image, base64, for attaching to an ordinary AI call (the
 * "Describe the picture" feedback), so the picture never travels through the
 * browser. Null when the scene is not there. Never throws.
 */
export async function loadSceneImage(sceneId: unknown): Promise<{ data: string; mimeType: string } | null> {
  if (typeof sceneId !== 'string' || !ID_PATTERN.test(sceneId)) return null;
  try {
    const snap = await db.collection(SCENES_COLLECTION).doc(sceneId).get();
    const scene = snap.exists ? snap.data() : undefined;
    const path = scene?.path;
    if (!scene || scene.status !== 'ready' || typeof path !== 'string' || !path.startsWith(`${SCENES_COLLECTION}/`)) {
      return null;
    }
    const [buffer] = await storage.bucket().file(path).download();
    return { data: buffer.toString('base64'), mimeType: 'image/webp' };
  } catch (err: any) {
    logWarn('scene_image_load_failed', 'ask-ai', { sceneId, errorMessage: err?.message ?? 'unknown' });
    return null;
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Serve one `picture` request. Never trusts anything in it but ids: the shape
 * is checked here and everything that reaches a prompt comes from a document.
 *
 * Provider faults are thrown, for ask-ai to answer the way it answers every
 * other provider failure; everything else is a result.
 */
export async function handlePictureRequest(caller: PictureCaller, request: unknown): Promise<PictureResult> {
  if (!request || typeof request !== 'object') {
    return refuse(400, 'PICTURE_BAD_REQUEST', 'picture must be an object');
  }
  const picture = request as PictureRequest & { conceptId?: unknown; conceptIds?: unknown };
  const action = picture.action ?? 'word';

  if (action === 'scene') {
    return drawScene(caller, picture.conceptIds);
  }

  if (action !== 'word' && action !== 'report' && action !== 'regenerate') {
    return refuse(400, 'PICTURE_BAD_REQUEST', 'Unknown picture action');
  }
  if (typeof picture.conceptId !== 'string' || !ID_PATTERN.test(picture.conceptId)) {
    return refuse(400, 'PICTURE_BAD_REQUEST', 'picture.conceptId must be a concept id');
  }

  if (action === 'report') return reportPicture(caller, picture.conceptId);

  if (action === 'regenerate') {
    if (caller.tier !== 'admin') return refuse(403, 'PICTURE_ADMIN', 'Admin access required');
    return pictureForWord(caller, picture.conceptId, 'regenerate');
  }

  return pictureForWord(caller, picture.conceptId, 'word');
}
