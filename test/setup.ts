/**
 * Runs once before any test file's imports. Several api/*.ts modules read
 * process.env at module load time (Stripe price map, webhook secret,
 * frontend URL) — those must exist before the module is first imported by
 * any test, which is earlier than a per-file beforeEach could set them.
 */
process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_test_secret';
process.env.FRONTEND_URL ??= 'https://app.test.local';
process.env.STRIPE_PRICE_VOYAGER_MONTHLY ??= 'price_voyager_monthly';
process.env.STRIPE_PRICE_VOYAGER_YEARLY ??= 'price_voyager_yearly';
process.env.STRIPE_PRICE_MAESTRO_MONTHLY ??= 'price_maestro_monthly';
process.env.STRIPE_PRICE_MAESTRO_YEARLY ??= 'price_maestro_yearly';

// Belt and braces: a developer with a real RESEND_API_KEY exported in their
// shell must not send actual mail by running the test suite. Tests that
// exercise the provider path unset this themselves.
process.env.EMAIL_ENABLED ??= 'false';
process.env.PUSH_ENABLED ??= 'false';

// Same reasoning for error reporting: a real SENTRY_DSN in the shell must
// not turn a test run into a wave of issues in the production project.
// lib/sentry.ts is inert without a DSN, and this closes the other door.
process.env.SENTRY_ENABLED ??= 'false';
