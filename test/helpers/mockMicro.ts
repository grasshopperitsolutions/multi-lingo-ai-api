/**
 * Stand-in for the `micro` package's buffer(req) helper, mounted via
 * vi.mock('micro', () => import('../helpers/mockMicro')).
 * Reads req.__rawBody (set by createMockReqRes) so webhook signature tests
 * can control the exact bytes handed to stripe.webhooks.constructEvent.
 */
import { vi } from 'vitest';

export const buffer = vi.fn(async (req: any) => {
  if (req.__rawBody !== undefined) return Buffer.from(req.__rawBody);
  return Buffer.from(JSON.stringify(req.body ?? {}));
});
