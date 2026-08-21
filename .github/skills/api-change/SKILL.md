# API change skill

Use this skill for changes to authentication, Firestore, Storage, AI providers, Stripe, CORS, authorization, request validation, or frontend/API contracts.

## Route the task

- Auth and account lifecycle: `api/auth.ts`, `lib/verify-auth.ts`, `lib/require-admin.ts`, `lib/delete-user-account.ts`
- Firestore CRUD and authorization: `api/firestore.ts`, `lib/firestore-helpers.ts`, `lib/collection-policies.ts`
- Signed URLs and file ownership: `api/storage.ts`
- AI quotas and dispatch: `api/ask-ai.ts`, `lib/providers/`, `lib/types.ts`
- Checkout, portal, and webhook: `api/stripe.ts`, `lib/stripe.ts`
- Shared response/CORS/logging: `lib/response.ts`, `lib/cors.ts`, `lib/logger.ts`

## Minimal context sequence

1. Read the owning file and its nearest mirrored test.
2. Read the helper or type it delegates to only when the behavior crosses that boundary.
3. For contract changes, inspect the frontend API client and call sites in the sibling repo.
4. Make one focused edit, then run the matching test file before expanding the change.

## Rules that must survive edits

- `verifyAuth` is required for protected operations; Firebase Admin bypasses Firestore rules, so handler authorization is authoritative.
- `users` access is self-only unless the caller's own profile has `subscriptionTier: "admin"`.
- User billing/quota fields are server-managed and must remain stripped from generic client writes.
- Unlisted Firestore collections use `owner-or-admin`; shared collections need an explicit policy entry.
- Storage paths must remain scoped to the authenticated user; Stripe webhooks require signature verification.
- AI provider keys and Stripe/Firebase credentials never enter client responses or logs.

## Validation map

- Handler change: `npx vitest run test/api/<endpoint>.test.ts`
- Helper/policy change: `npx vitest run test/lib/<helper>.test.ts`
- Provider change: `npx vitest run test/lib/providers/<provider>.test.ts`
- Cross-cutting change: `npm test` then `npm run typecheck`
- Module-load environment behavior: check `test/setup.ts` before changing imports or env reads
