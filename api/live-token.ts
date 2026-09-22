import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuthSession } from '../lib/verify-auth';
import { db } from '../lib/firebase-admin';
import { getUserTier } from '../lib/require-admin';
import { logInfo, logWarn, startTimer } from '../lib/logger';
import { reportError, reportMessage } from '../lib/sentry';
import type { VercelRequest, VercelResponse } from '../lib/types';

/**
 * POST /api/live-token
 *
 * Mints a short-lived Gemini **ephemeral token** so the browser can open a Live
 * API session directly with Google.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 *
 * Every other AI feature in this app goes through `/api/ask-ai`, and this one
 * cannot. The Live API is a stateful **WebSocket** conversation, and Vercel
 * functions are HTTP handlers with a maximum duration — they cannot accept an
 * inbound socket and cannot hold one open for the length of a lesson. So the
 * session runs browser-to-Google, and the only thing the server can do is
 * decide *whether* it may start and hand over a credential scoped tightly
 * enough that it cannot be spent on anything else.
 *
 * ── What that costs us, stated plainly ─────────────────────────────────────
 *
 * The server never sees the conversation. It cannot count minutes, cannot
 * inspect what was said, and cannot stop a session early. The unit it *can*
 * control is **whether a session may begin**, which is why the token is minted
 * with `uses: 1` — one mint is one session, and that is the only quantity
 * anyone here can meter.
 *
 * The API key never leaves this function.
 *
 * ── Access is an Admin decision, not a constant in this file ───────────────
 *
 * This is the first endpoint to read `appConfig/config/tiersConfig` and honour
 * a feature grant server-side. It deliberately does **not** hardcode a tier
 * list the way `collection-policies` does for tutors: the point of the
 * Features and Tiers screens is that access is configuration, and a second
 * copy here would be a second place to change and a second place to forget.
 * Granting `ai_tutor` to a tier in Admin is what opens this endpoint to it.
 */

/** The feature key the Tiers screen grants. Not a tier list — see above. */
const FEATURE_KEY = 'ai_tutor';

/**
 * Used when the caller names no model.
 *
 * The model is the caller's to choose, exactly as it is for `ask-ai`: the
 * frontend reads it off the admin-edited `live-tutor-prompt` document, the
 * same document it renders the system instruction from, and sends it here.
 * This endpoint deliberately does **not** read that document itself — the
 * prompts collection is the frontend's to read in this codebase, and a second
 * reader would be a second place to change and a second thing to keep in step.
 *
 * Extended-thinking on purpose, and not the cheaper-sounding default: it is
 * the variant with proactive audio permanently enabled, which is what lets the
 * tutor decide *not* to answer — to let a learner finish a halting sentence
 * instead of talking over them. Google names plain `gemini-3.8-live` as the
 * default for low-latency voice agents, and for a tutor specifically that
 * trade is worth making the other way. Both cost the same.
 */
const FALLBACK_LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL ?? 'gemini-3.8-live-extended-thinking';

/**
 * A model id is a short slug. Anything longer is not one, and there is no
 * reason to hash, log or forward it — the same instinct as ask-ai's
 * MAX_PROMPT_LENGTH, applied to the one field this endpoint accepts.
 */
const MAX_MODEL_LENGTH = 200;

/**
 * `models/{model}`, the form Google's auth_tokens REST endpoint requires —
 * see the comment at its call site below for why. Strips an existing prefix
 * first so a `GEMINI_LIVE_MODEL` set to the fully-qualified form (someone
 * copying it straight out of Google's own docs, where every example is
 * qualified) does not double up into `models/models/...`.
 */
function _qualifiedModel(model: string): string {
  return `models/${model.replace(/^models\//, '')}`;
}

/**
 * Google's defaults are 30 minutes to send and 1 minute to open. Both are
 * shortened here: a token is handed out at the moment somebody presses start,
 * so a minute to connect is generous, and a lesson that has not begun within
 * it is a token that should have expired rather than sat in a tab.
 */
const NEW_SESSION_WINDOW_MS = 60_000;
const SESSION_LIFETIME_MS = 15 * 60_000;

const AUTH_TOKENS_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);
  if (handleCors(req, res)) return;

  const elapsed = startTimer();

  if (req.method !== 'POST') {
    return errorResponse(res, 'Method not allowed', 405);
  }

  const session = await verifyAuthSession(req, res);
  if (!session?.uid) return;
  const { uid } = session;

  // An anonymous visitor can read public config and send the contact form;
  // they cannot start a tutoring session. Checked explicitly rather than left
  // to the tier lookup, because an anonymous session has no user document and
  // would otherwise fall through as an unknown tier.
  if (session.isAnonymous) {
    return errorResponse(res, 'Sign in to start a conversation', 403);
  }

  if (!process.env.GEMINI_API_KEY) {
    // A fault with no exception behind it, which is what reportMessage is for
    // — the same treatment an unset CONTACT_INBOX gets in email.ts. Logging
    // this quietly meant every session 503'd with nobody alerted.
    await reportMessage(
      'live_token_not_configured',
      'live-token',
      'GEMINI_API_KEY is not set',
      { uid, statusCode: 503, durationMs: elapsed() },
    );
    return errorResponse(res, 'Live conversation is not configured', 503);
  }

  try {
    const [tierId, tiersSnapshot] = await Promise.all([
      // lib/require-admin.ts already owns "what tier is this caller", and it
      // deliberately returns undefined for a missing user document rather
      // than defaulting. Reading the document inline here meant a second
      // answer to one question, and the two disagreed precisely where it
      // matters: the inline version defaulted a missing document to
      // 'explorer', so a user with no profile would be granted whatever the
      // free tier happens to include. Failing closed is the right direction
      // for a paid feature, and it costs nothing — every signed-in user has a
      // document, so this only changes the anomalous case.
      getUserTier(uid),
      db.collection('appConfig').doc('config').collection('tiersConfig').get(),
    ]);

    const tierDoc = tiersSnapshot.docs.find((doc) => doc.id === tierId);
    const granted: string[] = tierDoc?.data()?.features ?? [];

    if (!granted.includes(FEATURE_KEY)) {
      // Not 401: they are who they say they are, their plan simply does not
      // include this. The client turns a 403 here into the upgrade prompt.
      logInfo('live_token_denied', 'live-token', { uid, tier: tierId, ms: elapsed() });
      return errorResponse(res, 'Your plan does not include live conversation', 403);
    }

    // The caller's model, the same way ask-ai takes providerParams.model.
    // Absent or unusable inherits the constant above, which is what a fresh
    // install with no model on its prompt document sends.
    //
    // Whatever is resolved here is locked into the token *and* echoed back, so
    // the two cannot drift — the browser prefers this value precisely because
    // a token only opens a session with the model it was minted for.
    const requestedModel: unknown = (req.body ?? {}).model;
    const askedFor =
      typeof requestedModel === 'string' && requestedModel.trim().length > 0
        ? requestedModel.trim().slice(0, MAX_MODEL_LENGTH)
        : '';
    const liveModel = askedFor || FALLBACK_LIVE_MODEL;

    // A text model here mints nothing and fails at Google with a 400. Cheap to
    // say so plainly, since the person who set it is the person reading these
    // logs — the same guard the {{speechPace}} and {{url}} placeholders carry.
    if (!liveModel.includes('live')) {
      logWarn('live_token_model_suspect', 'live-token', { uid, model: liveModel });
    }

    const now = Date.now();
    const response = await fetch(`${AUTH_TOKENS_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // One mint, one session. The only quantity this server can meter.
        uses: 1,
        expireTime: new Date(now + SESSION_LIFETIME_MS).toISOString(),
        newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MS).toISOString(),
        // The lock that makes handing this to a browser acceptable: a token
        // minted for a tutoring session can only ever open a tutoring session.
        //
        // `models/` prefixed here and nowhere else. Google's auth_tokens REST
        // endpoint wants the fully-qualified `models/{model}` form (that is
        // what its own request examples show) — this is a raw `fetch()`, not
        // the SDK, so nothing normalises it on the way out. The response sent
        // back to the browser below keeps the bare name: that value goes
        // to `ai.live.connect({ model })` through the @google/genai SDK, which
        // is what every SDK example uses unprefixed, and that call has never
        // been reached in production — every mint has failed with a 400 from
        // this endpoint first, on account of the missing prefix.
        liveConnectConstraints: {
          model: _qualifiedModel(liveModel),
          config: { responseModalities: ['AUDIO'] },
        },
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.name) {
      // Google's own error body names what was wrong — an invalid model
      // string, a malformed field, a quota rejection — and until now that
      // detail was thrown away. A "mint failed, status 400" log with nothing
      // else is a mystery, not a diagnosis; this repo's own history is why
      // that matters, since more than one Gemini model constant has drifted
      // wrong silently. Truncated because the body is untrusted upstream
      // content, not because it is expected to be long.
      const errorDetail = JSON.stringify(payload?.error ?? payload).slice(0, 500);
      // Reported, not merely logged: this answers a 502, and by ask-ai's own
      // rule a 5xx means the provider broke or we did. It is also the exact
      // failure that ran unnoticed in production until somebody said the
      // tutor would not start.
      await reportMessage(
        'live_token_mint_failed',
        'live-token',
        `Gemini refused to mint a token (${response.status})`,
        { uid, status: response.status, errorDetail, model: liveModel, durationMs: elapsed() },
      );
      return errorResponse(res, 'Could not start a conversation right now', 502);
    }

    logInfo('live_token_minted', 'live-token', {
      uid,
      tier: tierId,
      model: liveModel,
      // Which lever set it, so a surprising model in the logs says where to
      // go and change it.
      source: askedFor ? 'caller' : 'fallback',
      ms: elapsed(),
    });

    return successResponse(res, {
      // `name` is the token itself; the browser sends it where an API key
      // would go when opening the socket.
      token: payload.name,
      model: liveModel,
      expiresAt: new Date(now + SESSION_LIFETIME_MS).toISOString(),
    });
  } catch (error) {
    // reportError logs internally (lib/sentry.ts) — a second logError here
    // emitted two lines per failure, one with the error and no timing, one
    // with timing and no error.
    await reportError('live_token_error', 'live-token', error as Error, {
      uid,
      statusCode: 500,
      durationMs: elapsed(),
    });
    return errorResponse(res, 'Could not start a conversation right now', 500);
  }
}
