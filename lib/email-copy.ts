/**
 * Email copy, localized off the same Firestore locale documents the
 * frontend UI uses.
 *
 * The frontend bundles exactly one locale — pt-PT, in
 * src/locales/pt/translation.json — and treats it as the canonical source
 * every other locale (en-US included) is AI-translated from and served from
 * Firestore. This module mirrors that arrangement exactly: EMAIL_COPY_BASE
 * below is the Portuguese source, and every other language is read from
 * appConfig/config/locales/{locale}.
 *
 * EMAIL_COPY_BASE lives in email-copy.base.ts and is **generated**, never
 * hand-edited: `npm run sync:email-copy` rewrites it from the frontend's
 * pt-PT file, and CI fails when the two disagree. The two repos deploy
 * separately and cannot import each other, so a copy has to exist here — but
 * it is a derived artifact rather than a second source of truth, which is the
 * only arrangement in which the two cannot silently drift.
 *
 * **There is deliberately no pt-PT document in Firestore.** One existed, as an
 * abandoned partial seed that nothing read, and it was deleted rather than
 * synchronised: a copy in a database is a copy no pull request can be gated
 * on, and that is the one that drifts. Portuguese is served from this file and
 * changed by deploying it.
 *
 * Resolution falls back in three steps — requested locale, then en-US, then
 * this bundled Portuguese — so an unfilled locale yields English rather than
 * the source language. See getEmailCopy().
 *
 * The frontend's fill pipeline (fillMissingTranslations) diffs the whole
 * bundled source against every locale document, so the `email.*` keys
 * propagate on their own — no UI has to render them.
 */

import { db } from './firebase-admin';
import { EMAIL_COPY_BASE as GENERATED_BASE } from './email-copy.base';
import { logWarn } from './logger';

/** Matches BASE_LOCALE in the frontend's src/i18n.js. */
export const BASE_LOCALE = 'pt-PT';

/**
 * Tried before giving up on the bundled Portuguese. A user whose own locale
 * hasn't been AI-filled yet is far better served by English than by the
 * source language of an app they may not speak.
 */
export const FALLBACK_LOCALE = 'en-US';

/**
 * BCP-47-ish shape check, applied before a locale ever reaches Firestore.
 * `interfaceLang` is client-writable through PUT /api/firestore (settings),
 * so it can hold anything; this stops a junk value turning into a pointless
 * document read and a cache entry keyed on garbage.
 */
export const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface EmailCopy {
  common: Record<string, string>;
  [template: string]: Record<string, string>;
}

/**
 * The Portuguese source strings, from the generated file. Typed here rather
 * than there because the generated file is data — giving it an import of its
 * own consumer's interface would make a regeneration able to break the build
 * in a way that has nothing to do with the strings.
 */
export const EMAIL_COPY_BASE: EmailCopy = GENERATED_BASE;

/** Substitutes {{var}} placeholders — same convention as the frontend's renderTemplate. */
export function renderTemplate(str: string, vars: Record<string, string | number> = {}): string {
  return str.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    key in vars ? String(vars[key]) : match
  );
}

/** Per-container cache. Vercel reuses warm containers, so this avoids a Firestore read per email. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { copy: EmailCopy; at: number }>();

/**
 * Drops every cached locale. Exported for tests, which seed different
 * documents for the same locale across cases; in production the TTL is the
 * only thing that expires an entry.
 */
export function clearEmailCopyCache(): void {
  cache.clear();
}

/**
 * Normalizes a stored interfaceLang to a locale document id.
 *
 * api/auth.ts seeds `interfaceLang: 'en'` at first sign-in, while the
 * frontend's language picker writes BCP-47 codes ('en-US', 'pt-PT', ...).
 * A bare 'en' plainly means en-US, and mapping it here stops brand-new
 * users falling all the way back to Portuguese.
 */
function normalizeLocale(locale?: string | null): string | null {
  if (!locale || !LOCALE_PATTERN.test(locale)) return null;
  if (locale === 'en') return FALLBACK_LOCALE;
  if (locale === 'pt') return BASE_LOCALE;
  return locale;
}

/** Reads one locale document's `email` subtree. Null when absent or unreadable. */
async function readLocaleEmail(locale: string): Promise<Record<string, unknown> | null> {
  try {
    const snap = await db
      .collection('appConfig').doc('config')
      .collection('locales').doc(locale)
      .get();
    const email = snap.exists ? (snap.data()?.email as Record<string, unknown>) : null;
    return email ?? null;
  } catch (err: any) {
    logWarn('email_copy_fetch_failed', 'email-copy', { locale, errorMessage: err?.message });
    return null;
  }
}

/**
 * English copy: the en-US locale document merged over the bundled base.
 * Cached like any other locale, since nearly every non-Portuguese send
 * needs it as the fallback layer.
 */
async function getFallbackCopy(): Promise<EmailCopy> {
  const cached = cache.get(FALLBACK_LOCALE);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.copy;

  const localeEmail = await readLocaleEmail(FALLBACK_LOCALE);
  const copy = localeEmail ? mergeOver(EMAIL_COPY_BASE, localeEmail) : EMAIL_COPY_BASE;
  cache.set(FALLBACK_LOCALE, { copy, at: Date.now() });
  return copy;
}

/**
 * Resolves email copy for a user's interface language.
 *
 * Three layers, each filling the gaps in the one before it:
 *
 *   requested locale  ->  en-US  ->  bundled pt-PT
 *
 * The merge is per string, not per document, so a locale the AI has only
 * half-filled yields its own translations for the keys it has and English
 * for the rest — rather than dropping the whole email into another language.
 * The bundled Portuguese is the floor and should never actually surface
 * unless the en-US document is missing too.
 *
 * pt-PT short-circuits: it is the source, and there is deliberately no pt-PT
 * document in Firestore to read (see the module comment). A locale that fails
 * the shape check, or is absent, is treated as unset and gets English.
 */
export async function getEmailCopy(locale?: string | null): Promise<EmailCopy> {
  const normalized = normalizeLocale(locale);
  if (normalized === BASE_LOCALE) return EMAIL_COPY_BASE;

  const english = await getFallbackCopy();
  if (!normalized || normalized === FALLBACK_LOCALE) return english;

  const cached = cache.get(normalized);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.copy;

  const localeEmail = await readLocaleEmail(normalized);
  // Expected until the AI-fill pipeline reaches this locale.
  const copy = localeEmail ? mergeOver(english, localeEmail) : english;
  cache.set(normalized, { copy, at: Date.now() });
  return copy;
}

/** Deep-merges a (possibly partial) email subtree over `base`, string by string. */
function mergeOver(base: EmailCopy, localeEmail: Record<string, unknown>): EmailCopy {
  const merged: EmailCopy = {} as EmailCopy;
  for (const [section, baseStrings] of Object.entries(base)) {
    const localeSection = localeEmail?.[section];
    merged[section] = { ...baseStrings };
    if (localeSection && typeof localeSection === 'object') {
      for (const [key, value] of Object.entries(localeSection as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) merged[section][key] = value;
      }
    }
  }
  return merged;
}
