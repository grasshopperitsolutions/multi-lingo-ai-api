# AGENTS.md

Read [CLAUDE.md](CLAUDE.md) before answering questions, proposing changes, or editing this repository. It is the canonical project brief; this file is the short routing layer for all agents.

## First decision

- `api/*.ts` owns HTTP method handling, request validation, and response mapping.
- `lib/*.ts` owns reusable authorization, Firebase, Stripe, logging, response, and provider behavior.
- `lib/collection-policies.ts` owns access rules for shared Firestore collections. Do not hardcode those rules in `api/firestore.ts`. A new policy has to hold on **both** read paths — single-document and collection-query; see the authorization section of `CLAUDE.md`.
- `lib/email.ts`, `lib/email-copy.ts`, `lib/email-templates.ts`, `lib/notification-prefs.ts` and `lib/push.ts` own notifications; `api/email.ts` is the only route. `lib/sentry.ts` owns error reporting and is called from the top-level catch blocks, not from business logic.
- `test/` mirrors `api/` and `lib/`; update the narrowest corresponding test when behavior changes.
- The sibling frontend is `C:\Nuno\Projects\GrasshopperWebSite\projects\multi-lingo-ai`. Inspect its API client and call sites when changing a request or response contract.

## Required workflow

1. Read the relevant section of `CLAUDE.md`, then inspect one owning implementation and its nearest test.
2. Decide whether the change is handler logic, a shared helper, a collection policy, a provider adapter, or a frontend contract.
3. Preserve authentication, ownership/admin checks, protected user fields, CORS, webhook verification, and server-only secrets.
4. Make the smallest compatible change; do not add an endpoint when an existing consolidated endpoint owns the behavior.
5. Run the narrowest relevant Vitest file, then `npm run typecheck`. Use `npm test` or `npm run test:coverage` for cross-cutting changes.

## Avoid wasted context

Do not read `coverage/`, `node_modules/`, generated output, or the full API surface unless the task requires it. Prefer targeted files and tests over broad repository scans. Never treat README examples or coverage output as the implementation source of truth.

## Do not assume

- Firebase rules protect this API; Vercel handlers and Firebase Admin authorization are the enforcement boundary.
- An authenticated caller is an admin; admin status is `users/{uid}.subscriptionTier === "admin"`.
- A new Firestore collection is shared; unlisted collections use the default policy.
- Environment variables are available in tests; module-load configuration is seeded in `test/setup.ts`.
- A green test suite means a dependency upgrade is safe. The suite mocks `lib/firebase-admin` and `lib/stripe`, so a package's module format (CJS vs ESM) is never exercised — that is how firebase-admin 14 took production down. See the Firebase Admin section of `CLAUDE.md`.
- Frontend and backend request shapes can change independently; verify both sides for contract changes.
