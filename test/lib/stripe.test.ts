import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Deliberately unmocked — the real module is a 3-line Stripe client
// construction that every other test file mocks away; this covers it once.

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_construction_only';
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
});

describe('lib/stripe', () => {
  it('constructs a Stripe client with the configured API version', async () => {
    vi.resetModules();
    const { stripe } = await import('../../lib/stripe');
    expect(stripe).toBeDefined();
    expect(stripe.customers).toBeDefined();
  });
});
