/**
 * Error reporting to Sentry, for the failures the NDJSON logs record but
 * nobody reads. lib/logger.ts stays the source of truth for what happened;
 * this adds the alert and the stack trace on top of it.
 *
 * Three deliberate choices, all of them about running inside a serverless
 * function rather than a long-lived server:
 *
 * 1. The SDK is imported lazily, on the first error only. A static import
 *    would load ~1MB of JavaScript into every cold start of all six
 *    functions to serve requests that overwhelmingly never fail.
 * 2. initWithoutDefaultIntegrations() instead of init(). The v10 default set
 *    installs OpenTelemetry auto-instrumentation that patches http, fs and
 *    every database driver it can find — the wrong trade for a proxy that
 *    only wants captureException(), and the main reason @sentry/node is
 *    expensive on Vercel.
 * 3. Every report is flushed before the handler responds. Vercel can freeze
 *    the instance the moment the response is sent, and a queued event dies
 *    with it — so the flush has to happen on the way out, not after.
 *
 * Disabled unless SENTRY_DSN is set, which is what keeps the test suite and
 * local development from reporting anything. Same posture as
 * isEmailEnabled() in lib/email.ts.
 */

import type { ErrorEvent as SentryErrorEvent, Scope } from '@sentry/node';
import { logError, type LogPayload } from './logger';

/** Long enough for one HTTP round trip to Sentry, short enough not to hang a 500. */
const FLUSH_TIMEOUT_MS = 2000;

type ErrorExtra = Omit<LogPayload, 'level' | 'event' | 'handler'>;

let initPromise: Promise<typeof import('@sentry/node') | null> | null = null;

export function isSentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN) && process.env.SENTRY_ENABLED !== 'false';
}

/**
 * Strips anything that could carry personal data before an event leaves the
 * process. sendDefaultPii: false already keeps Sentry from inferring an IP
 * address, and nothing here attaches a request — this is the belt to that
 * pair of braces, since an accidental `scope.setContext('request', ...)` at
 * some future call site shouldn't be the thing that leaks a payload.
 */
function scrub(event: SentryErrorEvent): SentryErrorEvent {
  delete event.request;
  delete event.server_name;
  return event;
}

/**
 * Loads and initializes the SDK on first use. Memoized on the promise rather
 * than a boolean so two errors in the same invocation can't race into two
 * init() calls. Resolves to null when reporting is disabled or the SDK
 * fails to load — reporting an error must never become an error.
 */
function getSentry(): Promise<typeof import('@sentry/node') | null> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!isSentryEnabled()) return null;
    try {
      const Sentry = await import('@sentry/node');

      Sentry.initWithoutDefaultIntegrations({
        dsn: process.env.SENTRY_DSN,
        // Cheap and useful: unwrap `cause` chains, drop repeats, and read the
        // few source lines around each frame. All of them run on the error
        // path only — none of them patch the runtime.
        integrations: [
          Sentry.linkedErrorsIntegration(),
          Sentry.dedupeIntegration(),
          Sentry.contextLinesIntegration(),
        ],
        environment: process.env.VERCEL_ENV ?? 'development',
        release: process.env.VERCEL_GIT_COMMIT_SHA,
        // No IP address, no request headers, no cookies. The privacy policy
        // commits to this: Sentry is a processor for fixing faults, not a
        // source of user data.
        sendDefaultPii: false,
        // Errors only. Tracing is what turns an error reporter into an
        // analytics tool, which section 3.4 of the privacy policy rules out.
        tracesSampleRate: 0,
        registerEsmLoaderHooks: false,
        beforeSend: scrub,
      });

      return Sentry;
    } catch (err: any) {
      // Not logError() — that would recurse straight back into here.
      console.warn(`[sentry] initialization failed: ${err?.message}`);
      return null;
    }
  })();

  return initPromise;
}

/** Applies the shared tags/context every report carries to a forked scope. */
function describe(scope: Scope, event: string, handler: string, extra: ErrorExtra): void {
  const { uid, ...rest } = extra;
  scope.setTag('handler', handler);
  scope.setTag('event', event);
  // Masked to 8 characters, exactly as lib/logger.ts masks it — enough to
  // group an issue by who hit it, not enough to be a user identifier.
  if (typeof uid === 'string' && uid) {
    scope.setUser({ id: `${uid.slice(0, 8)}...` });
  }
  scope.setContext('handler', rest as Record<string, unknown>);
}

/**
 * Logs an error line and reports the exception, then waits for it to reach
 * Sentry. Replaces a bare logError() call at the top-level catch blocks:
 * the NDJSON output is unchanged, so nothing that reads the Vercel logs
 * needs to know this happened.
 *
 * Never throws and never rejects — a failure to report is not a failure to
 * handle the request.
 */
export async function reportError(
  event: string,
  handler: string,
  err: unknown,
  extra: ErrorExtra = {}
): Promise<void> {
  const message = (err as any)?.message;
  logError(event, handler, { errorMessage: message, ...extra });

  try {
    const Sentry = await getSentry();
    if (!Sentry) return;

    Sentry.withScope((scope) => {
      describe(scope, event, handler, extra);
      Sentry.captureException(err);
    });

    await Sentry.flush(FLUSH_TIMEOUT_MS);
  } catch (reportErr: any) {
    console.warn(`[sentry] could not report "${event}": ${reportErr?.message}`);
  }
}

/**
 * Same contract as reportError() for the failures that have no exception
 * behind them — a required environment variable that was never set, say.
 * Those are exactly the faults worth an alert, since they are silent in
 * every other respect.
 */
export async function reportMessage(
  event: string,
  handler: string,
  message: string,
  extra: ErrorExtra = {}
): Promise<void> {
  logError(event, handler, { errorMessage: message, ...extra });

  try {
    const Sentry = await getSentry();
    if (!Sentry) return;

    Sentry.withScope((scope) => {
      describe(scope, event, handler, extra);
      Sentry.captureMessage(message, 'error');
    });

    await Sentry.flush(FLUSH_TIMEOUT_MS);
  } catch (reportErr: any) {
    console.warn(`[sentry] could not report "${event}": ${reportErr?.message}`);
  }
}

/** Test-only: drops the memoized client so a later call re-reads the env. */
export function resetSentryForTests(): void {
  initPromise = null;
}
