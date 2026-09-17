#!/usr/bin/env node
/**
 * Regenerates lib/email-copy.base.ts from the frontend's pt-PT locale file.
 *
 * The email and push-reminder copy has to exist in both repos: they deploy
 * separately and cannot import each other, and this repo needs copy that
 * still sends when Firestore is unreachable. Two hand-maintained copies of
 * the same strings drift — so this one is generated, committed, and checked.
 *
 *   node scripts/sync-email-copy.mjs            rewrite the file
 *   node scripts/sync-email-copy.mjs --check    exit 1 if it is out of date
 *
 * The --check form is what CI runs. It is deliberately not `git diff` on a
 * generated file: this reports which strings differ, which is the thing you
 * need to know when it fails.
 *
 * Reads the sibling checkout when there is one, so it is instant offline and
 * during local work, and falls back to the raw file on the frontend's default
 * branch. That fetch is unauthenticated because the repo is public; if it
 * ever goes private this needs a read-only token in the Authorization header
 * and a GH_TOKEN secret wired into ci.yml.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(HERE, '../lib/email-copy.base.ts');

const SIBLING = resolve(HERE, '../../../projects/multi-lingo-ai/src/locales/pt/translation.json');
const REMOTE =
  'https://raw.githubusercontent.com/grasshopperitsolutions/multi-lingo-ai/master/src/locales/pt/translation.json';

/** The frontend's pt-PT bundle, from the sibling checkout or from GitHub. */
async function readSource() {
  if (existsSync(SIBLING)) {
    return { where: 'sibling checkout', json: JSON.parse(readFileSync(SIBLING, 'utf8')) };
  }
  const response = await fetch(REMOTE);
  if (!response.ok) {
    throw new Error(`could not fetch the frontend locale file: HTTP ${response.status}`);
  }
  return { where: REMOTE, json: await response.json() };
}

/**
 * The generated file's exact text.
 *
 * The frontend's checker rebuilds this string from its own copy of the bundle
 * and compares it to the committed file, so the format is a contract between
 * the two repos, not a style choice. Keep it deterministic: JSON.stringify
 * over the source object preserves that file's key order, and both repos read
 * the same file.
 *
 * **Line endings are not part of the contract**, and pretending otherwise
 * broke this on Windows. git's `core.autocrlf` rewrites the committed file to
 * CRLF on checkout while this always renders LF, so a byte comparison failed
 * on every Windows working copy while passing in CI — and running the writer
 * to "fix" it produced a file git normalised straight back. Both sides are
 * compared with line endings normalised.
 */
/** Line endings are not part of the format contract — see render(). */
const sameContent = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

export function render(email) {
  return `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * The \`email\` section of the frontend's src/locales/pt/translation.json,
 * which is the source of truth for every string in it. Regenerate with:
 *
 *     npm run sync:email-copy
 *
 * CI fails when this file and the frontend disagree, so an edit here is
 * either overwritten or blocks the build. Change the frontend file instead.
 *
 * \`reminders\` is push copy rather than email. It lives here because this is
 * where locale resolution already happens, and a parallel mechanism would be
 * a second thing to keep filled.
 */

export const EMAIL_COPY_BASE = ${JSON.stringify(email, null, 2)};
`;
}

const isCheck = process.argv.includes('--check');

const { where, json } = await readSource();
const email = json?.email;
if (!email || typeof email !== 'object') {
  console.error('[sync-email-copy] the frontend locale file has no `email` section');
  // Never process.exit() after the fetch above: killing the process while
  // undici still has a socket closing trips a libuv assertion on Windows.
  // Setting the code and falling off the end is the quiet way out.
  process.exitCode = 1;
} else {
  writeOrReport(email, render(email), where);
}

/** Writes the generated file, or compares against it, and sets the exit code. */
function writeOrReport(email, expected, where) {
  if (!isCheck) {
    const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
    if (sameContent(current, expected)) {
      // Rewriting a file whose content already matches would flip its line
      // endings and leave the working tree dirty for no reason.
      console.log(`[sync-email-copy] already in step with the ${where}; nothing written`);
      return;
    }
    writeFileSync(TARGET, expected, 'utf8');
    console.log(`[sync-email-copy] wrote lib/email-copy.base.ts from the ${where}`);
    return;
  }

  const actual = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
  if (sameContent(actual, expected)) {
    console.log(`[sync-email-copy] in sync with the ${where}`);
    return;
  }

  // Name the strings, not just the file — "something differs" sends whoever hit
  // this to diff two repos by hand.
  const flatten = (node, prefix = '') =>
    Object.entries(node).flatMap(([key, value]) =>
      value && typeof value === 'object'
        ? flatten(value, `${prefix}${key}.`)
        : [[`${prefix}${key}`, value]]
    );

  let committed = {};
  const match = actual.match(/export const EMAIL_COPY_BASE = ([\s\S]*);\s*$/);
  if (match) {
    try {
      committed = JSON.parse(match[1]);
    } catch {
      // Hand-edited into something unparseable; the file list below is enough.
    }
  }

  const here = Object.fromEntries(flatten(committed));
  const there = Object.fromEntries(flatten(email));
  const keys = [...new Set([...Object.keys(here), ...Object.keys(there)])].sort();

  console.error('[sync-email-copy] OUT OF SYNC with the frontend pt-PT file.\n');
  for (const key of keys) {
    if (here[key] === there[key]) continue;
    if (!(key in here)) console.error(`  + ${key}  (only in the frontend)`);
    else if (!(key in there)) console.error(`  - ${key}  (only in this repo)`);
    else {
      console.error(`  ~ ${key}`);
      console.error(`      this repo: ${JSON.stringify(here[key])}`);
      console.error(`      frontend:  ${JSON.stringify(there[key])}`);
    }
  }
  console.error('\nRun `npm run sync:email-copy` and commit the result.');
  process.exitCode = 1;
}
