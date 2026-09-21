#!/usr/bin/env node
/**
 * Collapses duplicate concepts in `wordPool` down to one document each.
 *
 *   node scripts/dedupe-word-pool.mjs             report what it would do
 *   node scripts/dedupe-word-pool.mjs --apply     actually delete
 *
 * Needs the same credentials the API runs on — FIREBASE_PROJECT_ID,
 * FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY. With them in a .env file:
 *
 *   node --env-file=.env scripts/dedupe-word-pool.mjs
 *
 * ── Why there are duplicates ───────────────────────────────────────────────
 *
 * `get-word-generate-new-concept-prompt` carries an avoid list naming every
 * word already in the pool, and the model was told not to repeat. It repeated
 * anyway: one crossword build wrote seven `passport` concepts in thirteen
 * seconds, each with its own reworded hint, every one generated while
 * "passport" sat in the list it had just been handed. The frontend now checks
 * `normalizedKey` before writing, so the pool should not grow new ones — this
 * clears what was written before that landed.
 *
 * ── What it keeps ──────────────────────────────────────────────────────────
 *
 * One document per `normalizedKey`, chosen in this order: `status: ready`
 * first, then the most translations, then the oldest. The middle rule is the
 * one that matters — the copies are not interchangeable. `lightning` has one
 * document with four languages including Mirandese and another with two, and
 * `ticket` has one with Japanese and one with Danish. Keeping an arbitrary
 * copy silently throws that work away.
 *
 * Deleting is `recursiveDelete`, so a concept's `translations` subcollection
 * goes with it. A plain document delete would leave those children in place,
 * unreachable and still stored, because Firestore does not cascade.
 *
 * ── What it does not do ────────────────────────────────────────────────────
 *
 * It does not merge. A language that only exists under a doomed copy is lost
 * with it — `ticket` keeps Japanese and loses Danish. Re-translating one word
 * on demand costs one AI call; writing a merge that has to reconcile two hints
 * for the same locale costs more than that and can be wrong.
 *
 * It does not touch `seenConceptIds` on user profiles. Those keep pointing at
 * deleted ids, which is harmless: an id that matches no concept simply never
 * filters anything out, and rewriting every user's profile to tidy up a list
 * nobody reads directly is a far bigger operation than the problem.
 *
 * It matches on the **English** `normalizedKey`, which is what the pool is
 * keyed on. Two English words that collapse to one word in the practice
 * language — `valley` and `dale` — are not duplicates here and are left alone.
 */

import admin from 'firebase-admin';

const APPLY = process.argv.includes('--apply');

const REQUIRED = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('Try: node --env-file=.env scripts/dedupe-word-pool.mjs');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

const db = admin.firestore();

/** The same transform `_writeNewConcept` uses to build `normalizedKey`. */
const keyOf = (doc) =>
  String(doc.normalizedKey ?? doc.sourceWord ?? '').toLowerCase().trim();

const seconds = (value) => value?._seconds ?? value?.seconds ?? 0;

async function main() {
  console.log(APPLY ? 'APPLYING — documents will be deleted.\n' : 'Dry run. Pass --apply to delete.\n');

  const snapshot = await db.collection('wordPool').get();
  console.log(`wordPool: ${snapshot.size} documents`);

  const groups = new Map();
  for (const doc of snapshot.docs) {
    const key = keyOf(doc.data());
    // A concept with no key at all cannot be matched against anything, and
    // guessing would be worse than leaving it.
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(doc);
  }

  const duplicated = [...groups.entries()].filter(([, docs]) => docs.length > 1);
  if (duplicated.length === 0) {
    console.log('No duplicates. Nothing to do.');
    return;
  }

  // Counted before anything is chosen, because the count is what chooses.
  const translationCount = new Map();
  for (const [, docs] of duplicated) {
    for (const doc of docs) {
      const children = await doc.ref.collection('translations').listDocuments();
      translationCount.set(doc.id, children.length);
    }
  }

  let deleted = 0;
  let translationsLost = 0;

  for (const [key, docs] of duplicated.sort((a, b) => b[1].length - a[1].length)) {
    const ranked = [...docs].sort((a, b) => {
      const readyA = a.data().status === 'ready' ? 0 : 1;
      const readyB = b.data().status === 'ready' ? 0 : 1;
      if (readyA !== readyB) return readyA - readyB;

      const countDiff = translationCount.get(b.id) - translationCount.get(a.id);
      if (countDiff !== 0) return countDiff;

      const ageDiff = seconds(a.data().createdAt) - seconds(b.data().createdAt);
      if (ageDiff !== 0) return ageDiff;

      return a.id.localeCompare(b.id); // deterministic across runs
    });

    const [keep, ...drop] = ranked;
    console.log(
      `\n${key} — ${docs.length} copies` +
        `\n  keep   ${keep.id}  (${translationCount.get(keep.id)} translations)`,
    );

    for (const doc of drop) {
      const lost = translationCount.get(doc.id);
      translationsLost += lost;
      console.log(`  delete ${doc.id}  (${lost} translations)`);
      if (APPLY) {
        await db.recursiveDelete(doc.ref);
        deleted += 1;
      }
    }
  }

  const wouldDelete = duplicated.reduce((n, [, docs]) => n + docs.length - 1, 0);

  console.log(
    `\n${duplicated.length} duplicated words across ` +
      `${duplicated.reduce((n, [, d]) => n + d.length, 0)} documents.`,
  );
  console.log(
    APPLY
      ? `Deleted ${deleted} documents and ${translationsLost} translations beneath them.`
      : `Would delete ${wouldDelete} documents and ${translationsLost} translations beneath them.`,
  );
  if (!APPLY) console.log('\nRe-run with --apply to do it.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exit(1);
  });
