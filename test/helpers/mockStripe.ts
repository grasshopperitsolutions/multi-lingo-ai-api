/**
 * In-memory stand-in for lib/stripe.ts, mounted via
 * vi.mock('../../lib/stripe', () => import('../helpers/mockStripe')).
 */
import { vi } from 'vitest';

let customers = new Map<string, any>();
let subscriptions = new Map<string, any>();
let webhookEvent: any = null;
let webhookError: Error | null = null;

export const stripe: any = {
  customers: {
    create: vi.fn(async (params: any) => {
      const id = `cus_${Math.random().toString(36).slice(2, 10)}`;
      const customer = { id, metadata: {}, ...params };
      customers.set(id, customer);
      return customer;
    }),
    retrieve: vi.fn(async (id: string) => {
      const c = customers.get(id);
      if (!c) {
        const err: any = new Error('No such customer');
        err.statusCode = 404;
        throw err;
      }
      return c;
    }),
  },
  checkout: {
    sessions: {
      create: vi.fn(async (params: any) => ({
        id: `cs_${Math.random().toString(36).slice(2, 10)}`,
        url: 'https://checkout.stripe.com/test-session',
        ...params,
      })),
    },
  },
  billingPortal: {
    sessions: {
      create: vi.fn(async (params: any) => ({
        id: `bps_${Math.random().toString(36).slice(2, 10)}`,
        url: 'https://billing.stripe.com/test-session',
        ...params,
      })),
    },
  },
  subscriptions: {
    retrieve: vi.fn(async (id: string) => {
      const s = subscriptions.get(id);
      if (!s) {
        const err: any = new Error('No such subscription');
        err.statusCode = 404;
        throw err;
      }
      return s;
    }),
    cancel: vi.fn(async (id: string) => {
      subscriptions.delete(id);
      return { id, status: 'canceled' };
    }),
  },
  webhooks: {
    constructEvent: vi.fn((_rawBody: any, _sig: any, _secret: any) => {
      if (webhookError) throw webhookError;
      if (!webhookEvent) throw new Error('No webhook event configured in test');
      return webhookEvent;
    }),
  },
};

export const __testUtils = {
  reset() {
    customers = new Map();
    subscriptions = new Map();
    webhookEvent = null;
    webhookError = null;
    vi.clearAllMocks();
  },
  seedCustomer(id: string, data: Record<string, unknown> = {}) {
    customers.set(id, { id, metadata: {}, ...data });
  },
  seedSubscription(id: string, data: Record<string, unknown> = {}) {
    subscriptions.set(id, { id, ...data });
  },
  setWebhookEvent(event: any) {
    webhookEvent = event;
    webhookError = null;
  },
  setWebhookError(err: Error) {
    webhookError = err;
  },
};
