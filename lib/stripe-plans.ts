import type { SubscriptionTier } from './types';

/**
 * Maps a Stripe Price ID to an internal subscription tier.
 *
 * Its own module, away from lib/stripe.ts, because two readers need it — the
 * webhook (api/stripe.ts) and the Pulse snapshot's revenue count
 * (lib/pulse-snapshot.ts) — and lib/stripe.ts is replaced wholesale by a mock
 * in tests. Price IDs stay in env vars, server-side.
 */
export function tierFromPriceId(priceId: string | undefined): SubscriptionTier {
  const voyagerPrices = [
    process.env.STRIPE_PRICE_VOYAGER_MONTHLY,
    process.env.STRIPE_PRICE_VOYAGER_YEARLY,
  ];
  const maestroPrices = [
    process.env.STRIPE_PRICE_MAESTRO_MONTHLY,
    process.env.STRIPE_PRICE_MAESTRO_YEARLY,
  ];
  if (priceId && voyagerPrices.includes(priceId)) return 'voyager';
  if (priceId && maestroPrices.includes(priceId)) return 'maestro';
  return 'explorer';
}
