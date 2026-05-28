/**
 * Centralized structured logger for Vercel serverless functions.
 *
 * Emits newline-delimited JSON (NDJSON) to stdout/stderr so that
 * Vercel's log viewer can display, filter, and search entries easily.
 *
 * Usage:
 *   import { log, startTimer } from '../lib/logger';
 *
 *   const t = startTimer();
 *   log({ level: 'info', event: 'request_complete', handler: 'ask-ai',
 *         uid: 'abc123', statusCode: 200, durationMs: t() });
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogPayload {
  /** Severity level — maps to console.log / console.warn / console.error */
  level: LogLevel;
  /**
   * Short snake_case identifier for the event being logged.
   * Examples: 'request_received', 'auth_success', 'ai_request_complete'
   */
  event: string;
  /** The API handler file that produced this log (e.g. 'ask-ai', 'auth', 'firestore') */
  handler: string;
  /** Authenticated user ID — masked to first 8 chars to avoid leaking full UIDs in logs */
  uid?: string;
  /** HTTP method of the incoming request */
  method?: string;
  /** HTTP status code sent in the response */
  statusCode?: number;
  /** End-to-end request duration in milliseconds — use startTimer() to measure */
  durationMs?: number;
  /** Any additional context fields relevant to the event */
  [key: string]: unknown;
}

/**
 * Emits a single structured log entry as a JSON line.
 *
 * - level 'info'  → console.log  (shows in Vercel "Runtime Logs" white)
 * - level 'warn'  → console.warn (shows in Vercel "Runtime Logs" yellow)
 * - level 'error' → console.error (shows in Vercel "Runtime Logs" red)
 *
 * The `uid` field is automatically masked to the first 8 characters
 * to avoid writing full Firebase UIDs into external log storage.
 */
export function log(payload: LogPayload): void {
  const { uid, ...rest } = payload;

  const entry = {
    timestamp: new Date().toISOString(),
    ...rest,
    // Mask uid: only log first 8 chars so logs are useful but not leaking
    ...(uid ? { uid: uid.slice(0, 8) + '...' } : {}),
  };

  const line = JSON.stringify(entry);

  switch (payload.level) {
    case 'error':
      console.error(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

/**
 * Returns a function that, when called, returns the elapsed milliseconds
 * since startTimer() was invoked. Use this to measure handler duration.
 *
 * Example:
 *   const elapsed = startTimer();
 *   // ... do work ...
 *   log({ ..., durationMs: elapsed() });
 */
export function startTimer(): () => number {
  const start = Date.now();
  return () => Date.now() - start;
}

/**
 * Convenience wrapper — logs at 'info' level.
 */
export function logInfo(
  event: string,
  handler: string,
  extra: Omit<LogPayload, 'level' | 'event' | 'handler'> = {}
): void {
  log({ level: 'info', event, handler, ...extra });
}

/**
 * Convenience wrapper — logs at 'warn' level.
 */
export function logWarn(
  event: string,
  handler: string,
  extra: Omit<LogPayload, 'level' | 'event' | 'handler'> = {}
): void {
  log({ level: 'warn', event, handler, ...extra });
}

/**
 * Convenience wrapper — logs at 'error' level.
 */
export function logError(
  event: string,
  handler: string,
  extra: Omit<LogPayload, 'level' | 'event' | 'handler'> = {}
): void {
  log({ level: 'error', event, handler, ...extra });
}
