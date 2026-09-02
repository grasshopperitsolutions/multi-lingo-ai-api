/**
 * In-memory stand-in for lib/email.ts, mirroring its named exports so
 * `vi.mock('../../lib/email', () => import('../helpers/mockEmail'))` swaps
 * cleanly. Records every send instead of calling Resend.
 */

import { vi } from 'vitest';
import type { EmailMessage, SendContext } from '../../lib/email';

export const BATCH_MAX = 100;

export interface RecordedSend {
  message: EmailMessage;
  context: SendContext;
}

const sent: RecordedSend[] = [];
let nextId = 0;
/** When true, sendEmailSafe reports failure (returns null) without recording. */
let failNext = false;

export const isEmailEnabled = vi.fn(() => true);

export const sendEmail = vi.fn(async (message: EmailMessage) => {
  sent.push({ message, context: { template: 'direct', category: 'transactional' } });
  return { id: `email-${++nextId}` };
});

export const sendEmailSafe = vi.fn(async (message: EmailMessage, context: SendContext) => {
  if (failNext) {
    failNext = false;
    return null;
  }
  sent.push({ message, context });
  return { id: `email-${++nextId}` };
});

/** Records every message individually so assertions read the same as single sends. */
export const sendEmailBatch = vi.fn(async (messages: EmailMessage[]) => {
  if (failNext) {
    failNext = false;
    throw new Error('mock batch failure');
  }
  messages.forEach((message) => {
    sent.push({ message, context: { template: 'batch', category: 'announcements' } });
    nextId++;
  });
  return messages.length;
});

export const sendBatchSafe = vi.fn(async (messages: EmailMessage[], context: Omit<SendContext, 'uid'>) => {
  if (failNext) {
    failNext = false;
    return 0;
  }
  messages.forEach((message) => {
    sent.push({ message, context: { ...context } as SendContext });
    nextId++;
  });
  return messages.length;
});

export const __testUtils = {
  reset() {
    sent.length = 0;
    nextId = 0;
    failNext = false;
    isEmailEnabled.mockClear();
    sendEmail.mockClear();
    sendEmailSafe.mockClear();
    sendEmailBatch.mockClear();
    sendBatchSafe.mockClear();
  },
  getSent: () => [...sent],
  /** Every send whose context.template matches. */
  sentFor: (template: string) => sent.filter((s) => s.context.template === template),
  failNextSend() {
    failNext = true;
  },
};
