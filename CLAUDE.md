# CLAUDE.md

This is the canonical project brief for Claude Code and other agents working in this repository. Read it before answering questions, proposing changes, or editing code. `AGENTS.md` and `.github/copilot-instructions.md` provide short routing layers; they do not override this file.

## Efficient agent workflow

1. Identify the owning endpoint, helper, policy, provider, or test before reading broadly.
2. Read that implementation and its nearest mirrored test; inspect the sibling frontend only for API contract changes.
3. Make the smallest compatible edit that preserves the security invariants below.
4. Run the narrowest matching Vitest file, then `npm run typecheck`; use the full suite for cross-cutting changes.

Avoid `coverage/`, `node_modules/`, generated output, and unrelated endpoints unless the task requires them. The implementation and tests are the source of truth, not coverage reports or README examples.

## What this is

A consolidated Vercel serverless API acting as a proxy in front of Firebase (Auth/Firestore/Storage), Stripe, and AI providers (OpenAI/Gemini/Perplexity) for the Multi-Lingo AI frontend. The frontend never talks to Firebase directly — `firestore.rules` denies all client reads/writes unconditionally, since every operation must go through this proxy using the Firebase Admin SDK (which bypasses those rules). This is the sole enforcement point for authorization.

There are exactly 5 endpoints, each a separate Vercel serverless function (120s max duration, see `vercel.json`):
- `api/auth.ts` — sign-in (Google; Apple/Facebook/X recognized but return 501), logout, account deletion
- `api/firestore.ts` — generic CRUD proxy over all Firestore collections
- `api/storage.ts` — signed-URL upload/download and file metadata via Cloud Storage
- `api/ask-ai.ts` — proxies chat/completion requests to OpenAI, Gemini, or Perplexity
- `api/stripe.ts` — Checkout/Billing Portal sessions plus the Stripe webhook

## Commands

```bash
npm test              # run the full test suite once (vitest run)
npm run test:watch    # watch mode
npm run test:coverage # run with coverage; fails below thresholds (60% lines/statements/functions/branches)
npm run typecheck     # tsc --noEmit
```

Run a single test file: `npx vitest run test/api/firestore.test.ts`
Run tests matching a name: `npx vitest run -t "some test name"`

Tests live under `test/`, mirroring `api/`/`lib/` 1:1 (e.g. `lib/cors.ts` -> `test/lib/cors.test.ts`). `test/helpers/` provides in-memory stand-ins for Firestore, Firebase Auth, Cloud Storage, and Stripe, wired in via `vi.mock` — the suite needs no real Firebase/Stripe project or credentials. `test/setup.ts` sets required env vars (Stripe price IDs, webhook secret, frontend URL) before any module import, since several `api/*.ts` files read `process.env` at module load time — this is why those vars can't just be set in a per-test `beforeEach`.

There is no lint script configured.

## Architecture

### Authorization model (the core thing to understand)

`api/firestore.ts` is a generic proxy: any collection path can be read/written through it, so authorization can't be hardcoded per-route — it's resolved per-request in `lib/firestore-helpers.ts` and `lib/collection-policies.ts`:

- Every request (including anonymous/guest Firebase sessions) must pass `lib/verify-auth.ts` (verifies the Firebase ID token, returns the uid, or sends 401).
- The `users` collection is special-cased: a caller may always read/write their own `users/{uid}` doc (and anything nested under it); touching another uid's doc/subcollection requires admin (`lib/require-admin.ts`, checks `subscriptionTier === 'admin'` on the caller's own profile).
- Every other collection defaults to `owner-or-admin` (writes require the document's own `createdBy`/`userId` owner or an admin; reads allow unowned documents but restrict documents owned by another user) unless `lib/collection-policies.ts` declares an explicit `EXACT_PATH_POLICIES` or `PREFIX_POLICIES` entry (`public`/`authenticated`/`admin` read or write). That file is where a new shared/config/pool collection's access rules get added — not in `api/firestore.ts` itself.
- Writing to `users` strips protected fields server-side (`stripProtectedUserFields` in `lib/firestore-helpers.ts`) — `subscriptionTier`, Stripe IDs/status, `aiCallsToday`/`aiCallsDate` can only be set by the Stripe webhook (`api/stripe.ts`) or the ask-ai quota counter (`api/ask-ai.ts`), never by a self- or admin-edit through the generic endpoint.
- Deleting a `users` doc through `api/firestore.ts` is rejected outright; account deletion must go through `DELETE /api/auth`, which cascades the Stripe subscription, Storage files, and Auth record (`lib/delete-user-account.ts`).

### Cross-cutting request handling

Every handler in `api/*.ts` follows the same shape: `setCorsHeaders` + `handleCors` (`lib/cors.ts`) first, then a method `switch`, wrapped in try/catch that logs via `lib/logger.ts` and responds with `successResponse`/`errorResponse` (`lib/response.ts`). CORS is origin-allow-listed (`ALLOWED_ORIGINS`, falling back to `FRONTEND_URL`) — an unmatched origin gets no CORS headers at all rather than a reflected/wildcarded one, so it fails closed. `vercel.json` adds security headers (CSP, HSTS, X-Frame-Options, etc.) to every `/api/*` response independently of the handler code.

### AI provider layer

`api/ask-ai.ts` handles quota enforcement (per-`subscriptionTier` daily limits: Explorer 3/day, Voyager 20/day, Maestro unlimited — toggled off entirely via `LIMITS_ENFORCED=false`) and request-size caps, then dispatches to `lib/providers/{openai,gemini,perplexity}.ts` based on `providerParams.provider`. Each provider module is a thin, independently swappable adapter; adding a provider means adding a module here and a case in the `api/ask-ai.ts` switch.

### Firestore path resolution

`api/firestore.ts` resolves arbitrary slash-separated collection/document paths (e.g. `users/{uid}/settings/{id}`) generically via `resolveCollection`/`resolveDocument`, alternating `.collection()`/`.doc()` calls — this is what lets one endpoint serve every collection instead of one route per collection. `parseCollectionPath` (`lib/firestore-helpers.ts`) validates/normalizes the path before it's used.

### Firebase Admin singleton

`lib/firebase-admin.ts` initializes the Admin SDK once (guarded by `admin.apps.length`) and exports `auth`, `db`, `storage`, `FieldValue` for reuse across all handlers — required env vars (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) throw at import time if missing, which is why `test/setup.ts` must pre-seed env vars before any test imports a handler.

## Companion frontend repo

The consumer of this API is `C:\Nuno\Projects\GrasshopperWebSite\projects\multi-lingo-ai`, a Vite+React app. This proxy's CORS allow-list (`lib/cors.ts`) is driven by `ALLOWED_ORIGINS`/`FRONTEND_URL`, which in practice is set to that frontend's origin — a mismatch there is the usual cause of blocked cross-origin requests during local dev. The frontend calls all 5 endpoints under `api/` (`/api/auth`, `/api/firestore`, `/api/storage`, `/api/ask-ai`, `/api/stripe`) with a Firebase ID token in `Authorization: Bearer <token>`, including anonymous/guest sessions for pre-login reads. When changing request/response shapes here, check that repo for matching client-side call sites.
