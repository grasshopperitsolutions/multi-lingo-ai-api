import { handleCors, setCorsHeaders } from '../lib/cors';
import { successResponse, errorResponse } from '../lib/response';
import { verifyAuthSession } from '../lib/verify-auth';
import { db } from '../lib/firebase-admin';
import { logInfo, logError, startTimer } from '../lib/logger';
import { reportError } from '../lib/sentry';
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
 * Locked into every token minted here, so a leaked one cannot be spent on a
 * different model or a cheaper-to-abuse configuration.
 */
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL ?? 'gemini-3.8-live-extended-thinking';

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
    logError('live_token_not_configured', 'live-token', { uid });
    return errorResponse(res, 'Live conversation is not configured', 503);
  }

  try {
    const [userDoc, tiersSnapshot] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('appConfig').doc('config').collection('tiersConfig').get(),
    ]);

    const tierId: string = userDoc.data()?.subscriptionTier ?? 'explorer';
    const tierDoc = tiersSnapshot.docs.find((doc) => doc.id === tierId);
    const granted: string[] = tierDoc?.data()?.features ?? [];

    if (!granted.includes(FEATURE_KEY)) {
      // Not 401: they are who they say they are, their plan simply does not
      // include this. The client turns a 403 here into the upgrade prompt.
      logInfo('live_token_denied', 'live-token', { uid, tier: tierId, ms: elapsed() });
      return errorResponse(res, 'Your plan does not include live conversation', 403);
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
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: { responseModalities: ['AUDIO'] },
        },
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.name) {
      logError('live_token_mint_failed', 'live-token', {
        uid,
        status: response.status,
        ms: elapsed(),
      });
      return errorResponse(res, 'Could not start a conversation right now', 502);
    }

    logInfo('live_token_minted', 'live-token', { uid, tier: tierId, model: LIVE_MODEL, ms: elapsed() });

    return successResponse(res, {
      // `name` is the token itself; the browser sends it where an API key
      // would go when opening the socket.
      token: payload.name,
      model: LIVE_MODEL,
      expiresAt: new Date(now + SESSION_LIFETIME_MS).toISOString(),
    });
  } catch (error) {
    await reportError('live_token_error', 'live-token', error as Error, { uid });
    logError('live_token_error', 'live-token', { uid, ms: elapsed() });
    return errorResponse(res, 'Could not start a conversation right now', 500);
  }
}
