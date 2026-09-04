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

There are exactly 6 endpoints, each a separate Vercel serverless function (120s max duration, see `vercel.json`; the account is on Vercel Pro, so the ceiling is 800s if one ever needs it):
- `api/auth.ts` — sign-in (Google; Apple/Facebook/X recognized but return 501), logout, account deletion
- `api/firestore.ts` — generic CRUD proxy over all Firestore collections
- `api/storage.ts` — signed-URL upload/download and file metadata via Cloud Storage
- `api/ask-ai.ts` — proxies chat/completion requests to OpenAI, Gemini, or Perplexity
- `api/stripe.ts` — Checkout/Billing Portal sessions plus the Stripe webhook
- `api/email.ts` — contact form and admin broadcast (POST), plus the nightly unread-report digest (GET, cron)

Adding a seventh is a last resort — see the notification section below for why `api/email.ts` absorbed three unrelated jobs rather than becoming three routes.

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
- **Both read paths enforce that**, and they do it differently. A single-document read runs `authorizeGenericDocRead`. A *collection query* returns whole documents with no per-document hook, so it is covered by two things instead: an `admin` read policy is gated up front with `requireAdmin`, and an `owner-or-admin` result is passed through `filterQueryResultsByOwnership`, which drops documents owned by somebody else and keeps unowned ones. `hasMore`/`lastDocumentId` are computed from the raw page, not the filtered one, so paging still walks past documents the caller cannot see. Forgetting the query path is how `files` metadata was briefly readable by any signed-in caller.
- `read: 'admin'` exists because `owner-or-admin` does **not** protect a server-written collection: a document with no `createdBy`/`userId` counts as unowned and therefore shared. Anything written only by the Admin SDK (`contactSubmissions`, `contactRateLimits`, `stripeEvents`, `cronRuns`, `appConfig/config/reports`) needs the explicit `admin` row.
- Writing to `users` strips protected fields server-side (`stripProtectedUserFields` in `lib/firestore-helpers.ts`) — `subscriptionTier`, Stripe IDs/status, `aiCallsToday`/`aiCallsDate` can only be set by the Stripe webhook (`api/stripe.ts`) or the ask-ai quota counter (`api/ask-ai.ts`), never by a self- or admin-edit through the generic endpoint.
- Deleting a `users` doc through `api/firestore.ts` is rejected outright; account deletion must go through `DELETE /api/auth`, which cascades the Stripe subscription, Storage files, and Auth record (`lib/delete-user-account.ts`).

### Cross-cutting request handling

Every handler in `api/*.ts` follows the same shape: `setCorsHeaders` + `handleCors` (`lib/cors.ts`) first, then a method `switch`, wrapped in try/catch that logs via `lib/logger.ts` and responds with `successResponse`/`errorResponse` (`lib/response.ts`). CORS is origin-allow-listed (`ALLOWED_ORIGINS`, falling back to `FRONTEND_URL`) — an unmatched origin gets no CORS headers at all rather than a reflected/wildcarded one, so it fails closed. `vercel.json` adds security headers (CSP, HSTS, X-Frame-Options, etc.) to every `/api/*` response independently of the handler code.

### AI provider layer

`api/ask-ai.ts` handles quota enforcement (per-`subscriptionTier` daily limits: Explorer 3/day, Voyager 20/day, Maestro unlimited — toggled off entirely via `LIMITS_ENFORCED=false`) and request-size caps, then dispatches to `lib/providers/{openai,gemini,perplexity}.ts` based on `providerParams.provider`. Each provider module is a thin, independently swappable adapter; adding a provider means adding a module here and a case in the `api/ask-ai.ts` switch.

### Notifications (email + web push)

One endpoint, `api/email.ts`, carries three jobs, because a consolidated route is this repo's convention and each job is small:

- `POST { action: 'contact' }` — the public contact form. Requires `verifyAuth`, which anonymous guest sessions satisfy; that is what stops it being an open mail relay. Rate-limited to 3/hour through a counter document in `contactRateLimits` (a single doc, not a `where(uid) + where(createdAt >=)` query, which would need a composite index that fails on first use in production). The submission is written to `contactSubmissions` **before** the send, so a message survives a provider outage.
- `POST { action: 'broadcast' }` — admin only. Modes `user`/`tier`/`all`, capped at `MAX_BROADCAST_RECIPIENTS`, with a `confirm: 'ALL'` interlock on the all-users mode.
- `GET` — the nightly unread-report digest, guarded by `CRON_SECRET` and scheduled in `vercel.json`. Idempotent per day via a date stamp in `cronRuns/report_digest`, and sends nothing when the count is zero.

Supporting modules:

- `lib/email.ts` — a thin `fetch` adapter over the Resend REST API, deliberately **not** the SDK, matching the style of `lib/providers/*.ts`. `sendEmailSafe`/`sendBatchSafe` never throw: a failed welcome email must not 500 a login, and a failed deletion notice must not abort an account deletion. Broadcasts go through the batch endpoint (100/request) because one request per recipient would exceed Resend's 10 req/s account limit.
- `lib/email-copy.ts` — resolves copy per locale with a three-layer, per-string merge: requested locale → `en-US` → the bundled `EMAIL_COPY_BASE` (pt-PT). `EMAIL_COPY_BASE` must stay in sync with the `email.*` subtree of the frontend's pt-PT locale file; they are two copies of the same strings in two repos.
- `lib/email-templates.ts` — one builder per notification, table-based with fully inline styles (mail clients strip `<style>`), each returning html **and** text.
- `lib/notification-prefs.ts` — `transactional` is always deliverable and short-circuits without a Firestore read; `announcements` and `reminders` are opt-out for email and opt-**in** for push.
- `lib/push.ts` — FCM web push over the existing Firebase credentials (no separate key; the frontend needs the matching VAPID key). Prunes dead tokens on send. Note `sendPushSafe` currently has no production caller — push is wired for broadcasts only.

Mail is sent inline from `api/auth.ts` (welcome, new users only), `api/stripe.ts` (four webhook cases), and `lib/delete-user-account.ts` (before any data is destroyed).

### Error reporting

`lib/sentry.ts` wraps `@sentry/node`. `reportError(event, handler, err, extra)` replaces a bare `logError()` at the top-level catch blocks — the NDJSON output is unchanged, so anything reading Vercel logs is unaffected. `reportMessage()` covers faults with no exception behind them, such as an unset `CONTACT_INBOX`.

Three things about it are deliberate and worth preserving:

- The SDK is imported **lazily**, on the first error only, so a cold start of a function that never fails pays nothing.
- `initWithoutDefaultIntegrations()`, because the v10 default set installs OpenTelemetry auto-instrumentation that patches http, fs and every driver it finds.
- Every report is **flushed before the handler responds**. Vercel can freeze the instance the moment the response is sent, and a queued event dies with it.

Two noise filters exist on purpose: `api/ask-ai.ts` only reports 5xx (a 4xx is the provider answering — rate limit, rejected prompt), and `api/auth.ts` skips the codes in `EXPECTED_AUTH_ERROR_CODES` (an expired ID token is a user leaving a tab open, not a fault). Inert without `SENTRY_DSN`; `test/setup.ts` also pins `SENTRY_ENABLED=false`.

### Firestore path resolution

`api/firestore.ts` resolves arbitrary slash-separated collection/document paths (e.g. `users/{uid}/settings/{id}`) generically via `resolveCollection`/`resolveDocument`, alternating `.collection()`/`.doc()` calls — this is what lets one endpoint serve every collection instead of one route per collection. `parseCollectionPath` (`lib/firestore-helpers.ts`) validates/normalizes the path before it's used.

### Firebase Admin singleton

`lib/firebase-admin.ts` initializes the Admin SDK once (guarded by `admin.apps.length`) and exports `auth`, `db`, `storage`, `getMessaging`, `FieldValue` for reuse across all handlers — required env vars (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) throw at import time if missing, which is why `test/setup.ts` must pre-seed env vars before any test imports a handler. `getMessaging` is a function rather than a value because `admin.messaging()` does credential work on first call and every handler imports this module.

**firebase-admin is pinned to 13.x and must stay there.** v14 pulls `jwks-rsa@4` → `jose@6`, which is pure ESM with no CJS entry point, and Vercel's runtime cannot `require()` ESM even on Node 24 — so every function dies at module load with `ERR_REQUIRE_ESM`, before `setCorsHeaders` runs. A platform-level 500 carries no CORS headers, so the symptom in the browser is "blocked by CORS policy", not a 500. Nothing local catches this: the test suite mocks this module, so the real package's format is never exercised, and typecheck does not look at packaging. Moving to v14 requires making this API ESM (`"type": "module"` plus an ESM build), which is a project, not a dependency bump. Dependabot will keep proposing it.

## Companion frontend repo

The consumer of this API is `C:\Nuno\Projects\GrasshopperWebSite\projects\multi-lingo-ai`, a Vite+React app. This proxy's CORS allow-list (`lib/cors.ts`) is driven by `ALLOWED_ORIGINS`/`FRONTEND_URL`, which in practice is set to that frontend's origin — a mismatch there is the usual cause of blocked cross-origin requests during local dev. The frontend calls five of the six endpoints under `api/` (`/api/auth`, `/api/firestore`, `/api/storage`, `/api/ask-ai`, `/api/stripe`, `/api/email`; the digest path of `/api/email` is cron-only) with a Firebase ID token in `Authorization: Bearer <token>`, including anonymous/guest sessions for pre-login reads. When changing request/response shapes here, check that repo for matching client-side call sites.
