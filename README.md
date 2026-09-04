# Multi-Lingo AI API

A consolidated API service for authentication, Firestore operations, and storage management using Firebase Admin SDK with Vercel serverless functions.

## API Endpoints

This API has **6 endpoints**:

### 1. Authentication - `POST` / `DELETE /api/auth`

Handles sign-in and account deletion via an `action` parameter in the request body (POST) or the caller's Bearer token (DELETE).

#### Actions:

**Social Login (Google)** — the only provider fully implemented today.
```json
POST /api/auth
{
  "action": "google",
  "idToken": "id_token_from_provider"
}
```
Verifies the Firebase ID token, creates the user's `users/{uid}` Firestore doc on first sign-in, and returns a Firebase custom token.

**Social Login (Apple, Facebook, X)** — recognized but not yet available; returns `501`.
```json
POST /api/auth
{
  "action": "apple" // or "facebook", "twitter"
}
```

**Logout**
```json
POST /api/auth
{
  "action": "logout"
}
```

**Delete account**
```http
DELETE /api/auth
Authorization: Bearer <token>
```
Deletes the caller's own account (Stripe subscription, Firestore doc + sub-collections, `files` docs, Storage uploads, and the Auth record). An admin caller may delete a different account by passing `{ "uid": "<targetUid>" }` in the body.

There is no email/password auth in this API — sign-in is federated (Google today; Apple/Facebook/X once enabled) via Firebase Auth.

### 2. Firestore - `/api/firestore`

Handles all Firestore CRUD operations via HTTP methods.

**Authentication Required**: Yes, for every method and every collection (a Firebase session is always required — this includes anonymous/guest sessions, which the frontend uses for pre-login reads).

Beyond that base requirement, most collections outside `users` follow a strict "owner or admin" rule by default: a document is only readable/writable by whoever created it (`createdBy`/`userId`) or an admin. Collections that are actually shared — app config that guests need to read (`appConfig/config/locales`, `.../languages`, etc.) or community content pools that any signed-in user reads and contributes to (`wordPool`, `wordLinkGamePool`, `wordLadderGamePool`, `examExercises`) — instead follow an explicit policy declared in **[`lib/collection-policies.ts`](lib/collection-policies.ts)**. That's the file to edit when a new shared/config/pool collection needs anything other than the strict default.

#### Create Document
```http
POST /api/firestore
Authorization: Bearer <token>
{
  "collection": "users",
  "data": {
    "name": "John Doe",
    "email": "john@example.com"
  },
  "id": "optional_custom_id" // Optional: if not provided, Firestore will auto-generate
}
```
Writing to the `users` collection requires `id` to equal your own uid (or, to write someone else's profile, admin). POSTing over an existing document merges onto it rather than replacing it outright.

#### Read Single Document
```http
GET /api/firestore?collection=users&id=user123
Authorization: Bearer <token>
```
Reading someone else's `users/{uid}` document, or anything nested under someone else's `users/{uid}/...` sub-collection, requires admin.

#### Query Documents
```http
GET /api/firestore?collection=files&filters=[{"field":"userId","op":"==","value":"user123"}]&orderBy=createdAt&order=desc&limit=20
Authorization: Bearer <token>
```

Query parameters:
- `collection` (required): The collection to query
- `filters` (optional): JSON array of `{ field, op, value }` objects. `op` is one of `== != < <= > >= array-contains in not-in array-contains-any`.
- `orderBy` (optional): Field to order by
- `order` (optional): Order direction - `asc` or `desc`
- `limit` (optional): Number of documents to return (default 100, capped at 200 regardless of what's requested)
- `startAfter` (optional): Document ID for pagination

Browsing or filter-querying the whole `users` collection requires admin — this is the read path the admin Users panel uses to list every user.

#### Update Document
```http
PUT /api/firestore
Authorization: Bearer <token>
{
  "collection": "users",
  "id": "user123",
  "data": {
    "name": "Jane Doe"
  }
}
```
`PATCH` is accepted as an alias for `PUT` (both call Firestore's `.update()`). Editing a document you don't own — outside `users/{yourUid}` and anything nested under it — requires admin.

#### Delete Document
```http
DELETE /api/firestore
Authorization: Bearer <token>
{
  "collection": "files",
  "id": "file123"
}
```
`users` collection documents cannot be deleted through this endpoint — use `DELETE /api/auth`, which cascades the Stripe subscription, Storage files, and Auth record along with the Firestore doc.

### 3. Storage - `/api/storage`

Handles all file storage operations via HTTP methods.

**Authentication Required**: Yes

#### Upload File (Generate Signed URL)
```http
POST /api/storage
Authorization: Bearer <token>
{
  "fileName": "document.pdf",
  "contentType": "application/pdf",
  "folder": "uploads", // "uploads" (default) or "avatars"
  "metadata": {
    "description": "Important document"
  }
}
```
`folder` must be `uploads` or `avatars`. `avatars` uploads are given a public-read ACL, so they're additionally restricted to image content types (`image/jpeg`, `image/png`, `image/webp`, `image/gif`). Response includes a signed URL for direct upload to storage.

#### Get Signed Download URL
```http
GET /api/storage?fileId=file123&expiresIn=3600
Authorization: Bearer <token>
```

#### Update File Metadata
```http
PUT /api/storage
Authorization: Bearer <token>
{
  "fileId": "file123",
  "fileName": "updated-document.pdf", // Optional: if provided, will upload new content
  "contentType": "application/pdf",
  "metadata": {
    "description": "Updated description"
  }
}
```

#### Delete File
```http
DELETE /api/storage
Authorization: Bearer <token>
{
  "fileId": "file123"
}
```
Or delete every file under one of your own folders at once with `{ "prefix": "uploads/<your-uid>/" }`.

### 4. AI - `POST /api/ask-ai`

Proxies chat/completion requests to OpenAI, Gemini, or Perplexity. `prompt` is capped at 8,000 characters; `messages` at 50 entries of up to 8,000 characters each. Daily usage quotas (Explorer: 3/day, Voyager: 20/day, Maestro: unlimited) are enforced by default — set `LIMITS_ENFORCED=false` to pause them during testing/beta.

### 5. Stripe - `POST /api/stripe`

Handles Stripe Checkout, Billing Portal sessions, and the Stripe webhook (routed by the presence of a `stripe-signature` header, verified via `STRIPE_WEBHOOK_SECRET` — no separate auth needed for that path). Webhook deliveries are made idempotent by a `stripeEvents/{event.id}` document created with `.create()`, so a Stripe retry is a no-op rather than a duplicate email.

### 6. Notifications - `POST` / `GET /api/email`

`POST { action: 'contact' }` submits the public contact form. It requires a Firebase session, which anonymous guest sessions satisfy — that is what stops it being an open mail relay — and is rate-limited to 3 per hour per caller. Every submission is stored in `contactSubmissions` before the send, so a message survives a provider outage.

`POST { action: 'broadcast' }` is admin-only and sends an announcement to a single user, a tier, or everyone (the all-users mode needs `confirm: "ALL"`). Recipients who have opted out of the `announcements` category are skipped, and delivery uses Resend's batch endpoint rather than one request per recipient.

`GET` is the nightly unread-report digest invoked by Vercel Cron. It is not callable by the app: it requires `Authorization: Bearer $CRON_SECRET`, is idempotent per day, and sends nothing when there are no unread reports.

Transactional mail (welcome, subscription activated/cancelled/ended, payment failed, account deleted) is sent inline from the endpoints that cause it, never through this one. It is exempt from the opt-out categories.

## User Data Management

User profiles and settings are managed through the generic Firestore endpoint:

#### Get User Profile
```http
GET /api/firestore?collection=users&id={userId}
Authorization: Bearer <token>
```

#### Update User Profile
```http
PUT /api/firestore
Authorization: Bearer <token>
{
  "collection": "users",
  "id": "{userId}",
  "data": {
    "displayName": "Updated Name",
    "photoURL": "https://new-photo.jpg",
    "settings": {
      "language": "en",
      "notifications": {
        "email": true,
        "push": false
      }
    }
  }
}
```
`subscriptionTier`, `stripeCustomerId`, `stripeSubscriptionId`, `subscriptionStatus`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `aiCallsToday`, and `aiCallsDate` are always stripped from a self-edit (and the Stripe/quota fields are stripped even from an admin edit) — these are only ever set by the Stripe webhook and the ask-ai quota counter.

## Authentication

All endpoints except the `POST /api/auth` sign-in actions require authentication via Firebase ID token.

**Headers:**
```
Authorization: Bearer <firebase_id_token>
```

Each endpoint handler uses `lib/verify-auth.ts` to:
1. Verify the Firebase ID token from the `Authorization` header
2. Return the authenticated user's UID for the handler to use
3. Respond with `401 Unauthorized` if the token is invalid or missing

Admin-gated actions (editing/reading another user's profile, browsing the `users` collection, deleting another account) additionally require `lib/require-admin.ts`'s check: the caller's own `users/{uid}` doc must have `subscriptionTier: "admin"`.

## CORS

Requests are only granted CORS headers when their `Origin` matches the `ALLOWED_ORIGINS` allow-list (comma-separated). If `ALLOWED_ORIGINS` is unset, `FRONTEND_URL` is used as the sole allowed origin instead. An origin that matches neither gets no CORS headers at all — the browser blocks the response on its own; non-browser callers are unaffected either way.

## Environment Variables

Required environment variables:
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`: Firebase service account credentials
- `FIREBASE_STORAGE_BUCKET`: Firebase storage bucket name
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`: Stripe API credentials
- `STRIPE_PRICE_VOYAGER_MONTHLY`, `STRIPE_PRICE_VOYAGER_YEARLY`, `STRIPE_PRICE_MAESTRO_MONTHLY`, `STRIPE_PRICE_MAESTRO_YEARLY`: Stripe Price IDs
- `FRONTEND_URL`: used for Stripe redirect URLs and as the default CORS-allowed origin
- `OPENAI_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`: AI provider credentials

Required for email notifications (`/api/email`, plus the welcome / billing / account-deletion mail sent inline from `api/auth.ts`, `api/stripe.ts` and `lib/delete-user-account.ts`):
- `RESEND_API_KEY`: Resend API key. The sending domain must be DNS-verified (SPF + DKIM) in the Resend dashboard first.
- `EMAIL_FROM`: sender identity, e.g. `Multi Lingo AI <noreply@grasshoppersolutions.online>`
- `CONTACT_INBOX`: where contact-form submissions are delivered

Optional:
- `ALLOWED_ORIGINS`: comma-separated list of allowed CORS origins — takes priority over `FRONTEND_URL` when set
- `LIMITS_ENFORCED`: set to `false` to pause ask-ai daily quotas (enforced by default)
- `EMAIL_REPLY_TO`: default Reply-To header when a template doesn't set its own
- `CRON_SECRET`: random string of 16+ characters. Vercel sends it as `Authorization: Bearer <value>` when it invokes the nightly report digest (`GET /api/email`, scheduled in `vercel.json`); without it set, that endpoint refuses every request. The account is on the Vercel Pro plan, so the schedule is honoured to the minute and a more frequent interval is possible if the digest ever needs one (Hobby would cap it at once a day and drift up to an hour).
- `EMAIL_ENABLED`: set to `false` to make every send a logged no-op (`email_skipped`). Useful for verifying trigger points before DNS is live. Anything other than the literal `false` leaves sending on.
- `PUSH_ENABLED`: same kill switch for web push. Web push needs no key of its own — it goes through the existing Firebase credentials via FCM — but the frontend needs the matching `VITE_FIREBASE_VAPID_KEY` (Firebase Console → Project Settings → Cloud Messaging → Web Push certificates).
- `SENTRY_DSN`: enables error reporting (`lib/sentry.ts`). Unset, nothing is reported and the SDK is never even loaded — the import is lazy, so a function that doesn't fail never pays for it. Use an EU-region project (`…ingest.de.sentry.io`); `VERCEL_ENV` and `VERCEL_GIT_COMMIT_SHA` are picked up automatically as the environment and release.
- `SENTRY_ENABLED`: set to `false` to silence reporting while leaving the DSN in place.

## Testing

```bash
npm test              # run the test suite once
npm run test:watch    # watch mode
npm run test:coverage # run with coverage; fails below the configured threshold
npm run typecheck     # tsc --noEmit
```

Tests live under `test/`, mirroring `api/`/`lib/`. `test/helpers/` holds in-memory stand-ins for Firestore, Firebase Auth, Cloud Storage, and Stripe, mounted via `vi.mock`, so the suite runs with no real Firebase/Stripe project or credentials. CI runs the full suite with coverage enforcement on every push and pull request.

## Deployment

This API is designed for Vercel serverless deployment. Each endpoint is a separate serverless function with a 120-second max duration (`vercel.json`).

## Security

- Every endpoint requires Firebase authentication except the `POST /api/auth` sign-in actions and the signature-verified Stripe webhook
- User and file data are protected by per-document ownership checks; documents with no verifiable owner are denied by default rather than allowed
- Admin-only actions require `subscriptionTier: "admin"` on the caller's own profile
- CORS is origin-allow-listed, not wildcarded
- `ask-ai` enforces per-tier daily quotas and request size caps by default
- Security-relevant response headers (`X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`, `Strict-Transport-Security`) are set on every `/api/*` response
- Collection *queries* are ownership-filtered too, not just single-document reads — server-written collections (`contactSubmissions`, `stripeEvents`, `cronRuns`, reports) are admin-read-only, and a default-policy query drops documents belonging to other users
- Unhandled failures are reported to Sentry with the uid masked to 8 characters, no IP address, and no request body

## Migration Notes

This API has been consolidated from multiple individual endpoints into 6 main endpoints for better maintainability and scalability. The old endpoints have been removed:
- All auth operations are now in `/api/auth`
- All Firestore operations are now in `/api/firestore`
- All storage operations are now in `/api/storage`
- User profile and settings are accessed via the Firestore endpoint
