import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The SDK is loaded through a dynamic import inside lib/sentry.ts, so the
 * mock has to be registered before the first reportError() call rather than
 * before the module import — vi.mock is hoisted, which covers both.
 */
// vi.hoisted, because the vi.mock factory is lifted above every other
// statement in the file and cannot close over ordinary top-level consts.
const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(async () => true),
  scope: {
    setTag: vi.fn(),
    setUser: vi.fn(),
    setContext: vi.fn(),
  },
}));

vi.mock('@sentry/node', () => ({
  initWithoutDefaultIntegrations: mocks.init,
  withScope: (fn: (s: typeof mocks.scope) => void) => fn(mocks.scope),
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
  flush: mocks.flush,
  linkedErrorsIntegration: () => ({ name: 'LinkedErrors' }),
  dedupeIntegration: () => ({ name: 'Dedupe' }),
  contextLinesIntegration: () => ({ name: 'ContextLines' }),
}));

import { isSentryEnabled, reportError, reportMessage, resetSentryForTests } from '../../lib/sentry';

const { init, captureException, captureMessage, flush, scope } = mocks;

const originalDsn = process.env.SENTRY_DSN;
const originalEnabled = process.env.SENTRY_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  resetSentryForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = originalDsn;
  if (originalEnabled === undefined) delete process.env.SENTRY_ENABLED;
  else process.env.SENTRY_ENABLED = originalEnabled;
});

const enable = () => {
  process.env.SENTRY_DSN = 'https://public@o1.ingest.de.sentry.io/2';
  delete process.env.SENTRY_ENABLED;
};

describe('lib/sentry — kill switch', () => {
  it('is disabled with no DSN, which is what keeps the test suite silent', () => {
    delete process.env.SENTRY_DSN;
    expect(isSentryEnabled()).toBe(false);
  });

  it('is disabled when SENTRY_ENABLED is explicitly "false", even with a DSN', () => {
    process.env.SENTRY_DSN = 'https://public@o1.ingest.de.sentry.io/2';
    process.env.SENTRY_ENABLED = 'false';
    expect(isSentryEnabled()).toBe(false);
  });

  it('never loads or initializes the SDK while disabled', async () => {
    delete process.env.SENTRY_DSN;
    await reportError('boom', 'firestore', new Error('nope'));
    expect(init).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('still writes the log line while disabled — logging is not conditional on Sentry', async () => {
    delete process.env.SENTRY_DSN;
    await reportError('boom', 'firestore', new Error('nope'));
    expect(console.error).toHaveBeenCalledOnce();
    const line = JSON.parse((console.error as any).mock.calls[0][0]);
    expect(line).toMatchObject({ level: 'error', event: 'boom', handler: 'firestore', errorMessage: 'nope' });
  });
});

describe('lib/sentry — reporting', () => {
  beforeEach(enable);

  it('captures the exception and flushes before returning', async () => {
    const err = new Error('firestore exploded');
    await reportError('firestore_unhandled_error', 'firestore', err, { statusCode: 500 });

    expect(captureException).toHaveBeenCalledWith(err);
    // Vercel can freeze the instance the moment the response is sent, so an
    // unflushed event would simply be lost.
    expect(flush).toHaveBeenCalled();
  });

  it('initializes once across repeated reports', async () => {
    await reportError('a', 'firestore', new Error('1'));
    await reportError('b', 'firestore', new Error('2'));
    expect(init).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('tags the handler and event so issues group per endpoint', async () => {
    await reportError('stripe_action_error', 'stripe', new Error('x'), { action: 'checkout' });
    expect(scope.setTag).toHaveBeenCalledWith('handler', 'stripe');
    expect(scope.setTag).toHaveBeenCalledWith('event', 'stripe_action_error');
  });

  it('masks the uid to 8 characters, matching lib/logger.ts', async () => {
    await reportError('x', 'auth', new Error('x'), { uid: 'abcdefghijklmnop' });
    expect(scope.setUser).toHaveBeenCalledWith({ id: 'abcdefgh...' });
  });

  it('keeps the uid out of the context object it attaches', async () => {
    await reportError('x', 'auth', new Error('x'), { uid: 'abcdefghijklmnop', statusCode: 500 });
    expect(scope.setContext).toHaveBeenCalledWith('handler', { statusCode: 500 });
  });

  it('omits the user entirely when there is no uid', async () => {
    await reportError('x', 'stripe', new Error('x'), { statusCode: 500 });
    expect(scope.setUser).not.toHaveBeenCalled();
  });

  it('reports a message for faults with no exception behind them', async () => {
    await reportMessage('contact_inbox_unset', 'email', 'CONTACT_INBOX is not set', { statusCode: 500 });
    expect(captureMessage).toHaveBeenCalledWith('CONTACT_INBOX is not set', 'error');
    expect(flush).toHaveBeenCalled();
  });
});

describe('lib/sentry — failures reporting failures', () => {
  beforeEach(enable);

  it('swallows a transport failure — a 500 must not become an unhandled rejection', async () => {
    flush.mockRejectedValueOnce(new Error('network down'));
    await expect(
      reportError('firestore_unhandled_error', 'firestore', new Error('boom'))
    ).resolves.toBeUndefined();
  });

  it('swallows a capture failure and still emits the log line', async () => {
    captureException.mockImplementationOnce(() => {
      throw new Error('sdk broke');
    });
    await expect(reportError('x', 'storage', new Error('boom'))).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledOnce();
  });
});
