# Copilot instructions

Read [../CLAUDE.md](../CLAUDE.md) first. Treat it as the canonical architecture and security brief; use [../AGENTS.md](../AGENTS.md) for task routing.

## Efficient workflow

- Identify the owning endpoint/helper/policy/provider before reading broadly.
- Read the owning implementation, one neighboring test, and only the directly affected types or call site.
- For Firestore access changes, inspect `lib/collection-policies.ts` and `lib/firestore-helpers.ts` before editing `api/firestore.ts`.
- For request/response changes, inspect the sibling frontend at `C:\Nuno\Projects\GrasshopperWebSite\projects\multi-lingo-ai` and its API client call sites.
- For provider changes, read the provider adapter, `lib/types.ts`, and its provider test.
- Do not inspect `coverage/`, `node_modules/`, or generated files unless explicitly needed.

## Security invariants

- Keep `verifyAuth` on every protected operation; keep Stripe webhook signature verification on the webhook path.
- Preserve owner-or-admin checks, the `users/{uid}` boundary, protected user fields, CORS allow-listing, request-size caps, and server-only credentials.
- Never trust client-supplied subscription tiers, Stripe identifiers, ownership fields, or arbitrary storage prefixes.
- Prefer an existing consolidated endpoint over adding a new route.

## Validation

Run the narrowest matching command first:

```text
npx vitest run test/api/<endpoint>.test.ts
npx vitest run test/lib/<helper>.test.ts
npm run typecheck
```

Use `npm test` for cross-cutting changes and `npm run test:coverage` when coverage behavior is part of the task. There is no lint script in this repository.
