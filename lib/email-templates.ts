/**
 * HTML/text builders, one per notification.
 *
 * Everything is inline-styled and table-based: email clients strip <style>
 * blocks and have no flexbox/grid. Every template also emits a plain-text
 * alternative — a text/plain part materially improves deliverability and is
 * what screen readers and text-only clients render.
 */

import { renderTemplate, type EmailCopy } from './email-copy';
import type { EmailMessage } from './email';
import type { NotificationCategory } from './notification-prefs';

/**
 * Escapes user-supplied text before it goes anywhere near the HTML body.
 * The contact form and the admin composer both interpolate text a human
 * typed; without this, a message containing markup would be injected into
 * the mail we send (and into the admin's inbox).
 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const appUrl = () => process.env.FRONTEND_URL ?? 'https://multi-lingo-ai.vercel.app';

interface LayoutOptions {
  copy: EmailCopy;
  heading: string;
  paragraphs: string[];
  ctaLabel?: string;
  ctaPath?: string;
  category: NotificationCategory;
}

/** Wraps body content in the shared shell and returns both parts. */
function layout(opts: LayoutOptions): { html: string; text: string } {
  const { copy, heading, paragraphs, ctaLabel, ctaPath, category } = opts;
  const base = appUrl();
  const footerReason =
    category === 'transactional' ? copy.common.footer_transactional : copy.common.footer_optional;

  const bodyHtml = paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#0f172a;">${p}</p>`)
    .join('');

  const ctaHtml =
    ctaLabel && ctaPath
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
           <tr><td style="background:#2563eb;border:3px solid #0f172a;border-radius:12px;">
             <a href="${base}${ctaPath}" style="display:inline-block;padding:14px 28px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:#ffffff;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
           </td></tr>
         </table>`
      : '';

  // Preferences link only where it is actionable: a transactional notice
  // can't be switched off, so offering the link would be misleading.
  const prefsHtml =
    category === 'transactional'
      ? ''
      : ` &middot; <a href="${base}/settings" style="color:#475569;">${escapeHtml(copy.common.footer_prefs)}</a>`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:4px solid #0f172a;border-radius:24px;font-family:Helvetica,Arial,sans-serif;">
        <tr><td style="padding:32px 32px 8px;">
          <p style="margin:0 0 4px;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:2px;color:#64748b;">${escapeHtml(copy.common.app_name)}</p>
          <h1 style="margin:0 0 20px;font-size:26px;line-height:1.2;font-weight:bold;color:#0f172a;">${escapeHtml(heading)}</h1>
        </td></tr>
        <tr><td style="padding:0 32px 8px;">${bodyHtml}${ctaHtml}</td></tr>
        <tr><td style="padding:8px 32px 32px;border-top:2px solid #e2e8f0;">
          <p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#475569;">
            ${escapeHtml(copy.common.footer_tagline)}<br>
            ${escapeHtml(footerReason)}${prefsHtml}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const textParts = [
    copy.common.app_name.toUpperCase(),
    '',
    heading,
    '',
    // Strip the tags the HTML paragraphs may carry (e.g. <br>).
    ...paragraphs.map((p) => p.replace(/<[^>]+>/g, '')),
  ];
  if (ctaLabel && ctaPath) textParts.push('', `${ctaLabel}: ${base}${ctaPath}`);
  textParts.push('', '---', copy.common.footer_tagline, footerReason);
  if (category !== 'transactional') textParts.push(`${copy.common.footer_prefs}: ${base}/settings`);

  return { html, text: textParts.join('\n') };
}

function greeting(copy: EmailCopy, name?: string | null): string {
  return name
    ? renderTemplate(copy.common.greeting, { name: escapeHtml(name) })
    : copy.common.greeting_fallback;
}

/** Builds a standard single-message template from a copy section. */
function build(
  copy: EmailCopy,
  section: string,
  to: string,
  name: string | null | undefined,
  vars: Record<string, string | number>,
  ctaPath: string | undefined,
  category: NotificationCategory
): EmailMessage {
  const s = copy[section];
  const { html, text } = layout({
    copy,
    heading: renderTemplate(s.heading, vars),
    paragraphs: [greeting(copy, name), renderTemplate(s.body, vars)],
    ctaLabel: s.cta || undefined,
    ctaPath: s.cta ? ctaPath : undefined,
    category,
  });
  return { to, subject: renderTemplate(s.subject, vars), html, text };
}

export const welcomeEmail = (copy: EmailCopy, to: string, name?: string | null) =>
  build(copy, 'welcome', to, name, {}, '/dashboard', 'transactional');

export const subscriptionActivatedEmail = (copy: EmailCopy, to: string, name: string | null | undefined, tier: string) =>
  build(copy, 'subscription_activated', to, name, { tier }, '/dashboard', 'transactional');

export const subscriptionCancelScheduledEmail = (copy: EmailCopy, to: string, name: string | null | undefined, tier: string, date: string) =>
  build(copy, 'subscription_cancel_scheduled', to, name, { tier, date }, '/settings', 'transactional');

export const subscriptionEndedEmail = (copy: EmailCopy, to: string, name?: string | null) =>
  build(copy, 'subscription_ended', to, name, {}, '/pricing', 'transactional');

export const paymentFailedEmail = (copy: EmailCopy, to: string, name?: string | null) =>
  build(copy, 'payment_failed', to, name, {}, '/settings', 'transactional');

export const accountDeletedEmail = (copy: EmailCopy, to: string, name?: string | null) =>
  build(copy, 'account_deleted', to, name, {}, undefined, 'transactional');

/** Admin broadcast: subject and body are authored in the admin composer, so only the shell is templated. */
export function broadcastEmail(copy: EmailCopy, to: string, subject: string, body: string): EmailMessage {
  const { html, text } = layout({
    copy,
    heading: subject,
    // Author-entered blank lines become paragraphs; everything is escaped.
    paragraphs: body.split(/\n{2,}/).map((p) => escapeHtml(p.trim()).replace(/\n/g, '<br>')),
    ctaLabel: copy.common.button_open,
    ctaPath: '/dashboard',
    category: 'announcements',
  });
  return { to, subject, html, text };
}

/**
 * Contact-form submission, delivered to CONTACT_INBOX rather than to a user.
 * Always English — the audience is the operator, not the submitter — and
 * every interpolated field is attacker-controlled, hence escapeHtml on all
 * of them.
 */
export function contactFormEmail(
  to: string,
  submission: { name: string; email: string; phone?: string; subject: string; message: string; uid: string }
): EmailMessage {
  const rows: Array<[string, string]> = [
    ['From', submission.name],
    ['Email', submission.email],
    ['Phone', submission.phone || '-'],
    ['Topic', submission.subject],
    ['User ID', submission.uid],
  ];

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:3px solid #0f172a;border-radius:16px;padding:24px;">
    <tr><td>
      <h1 style="margin:0 0 16px;font-size:20px;color:#0f172a;">Contact form: ${escapeHtml(submission.subject)}</h1>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;font-size:14px;color:#0f172a;">
        ${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b;white-space:nowrap;">${k}</td><td style="padding:4px 0;">${escapeHtml(v)}</td></tr>`).join('')}
      </table>
      <div style="padding:16px;background:#f8fafc;border-left:4px solid #2563eb;font-size:15px;line-height:1.6;color:#0f172a;white-space:pre-wrap;">${escapeHtml(submission.message)}</div>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `Contact form: ${submission.subject}`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    submission.message,
  ].join('\n');

  return { to, subject: `[Contact] ${submission.subject} - ${submission.name}`, html, text, replyTo: submission.email };
}
