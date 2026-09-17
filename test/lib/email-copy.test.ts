import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/firebase-admin', () => import('../helpers/mockFirebaseAdmin'));

import { __testUtils, db } from '../helpers/mockFirebaseAdmin';
import {
  getEmailCopy, renderTemplate, clearEmailCopyCache, EMAIL_COPY_BASE, BASE_LOCALE, FALLBACK_LOCALE,
} from '../../lib/email-copy';

/** Writes a locale document at appConfig/config/locales/{locale}. */
async function seedLocale(locale: string, email: Record<string, unknown>) {
  await db.collection('appConfig').doc('config').collection('locales').doc(locale).set({ email });
}

beforeEach(() => {
  __testUtils.reset();
  clearEmailCopyCache();
});

describe('renderTemplate', () => {
  it('substitutes named placeholders', () => {
    expect(renderTemplate('Olá {{name}}, estás no plano {{tier}}', { name: 'Ana', tier: 'Voyager' }))
      .toBe('Olá Ana, estás no plano Voyager');
  });

  it('leaves unknown placeholders untouched rather than printing undefined', () => {
    expect(renderTemplate('Olá {{name}}')).toBe('Olá {{name}}');
  });
});

describe('getEmailCopy', () => {
  it('returns the bundled base copy for pt-PT when no document overrides it', async () => {
    await expect(getEmailCopy(BASE_LOCALE)).resolves.toBe(EMAIL_COPY_BASE);
    // 'pt' is normalized to the base locale rather than treated as missing.
    await expect(getEmailCopy('pt')).resolves.toBe(EMAIL_COPY_BASE);
  });

  it('falls back to the base copy when no locale is stored on the user', async () => {
    await expect(getEmailCopy(null)).resolves.toBe(EMAIL_COPY_BASE);
    await expect(getEmailCopy(undefined)).resolves.toBe(EMAIL_COPY_BASE);
  });

  it('normalizes the bare "en" that api/auth.ts seeds to the en-US document', async () => {
    await seedLocale('en-US', { welcome: { subject: 'Welcome to Multi Lingo AI' } });
    const copy = await getEmailCopy('en');
    expect(copy.welcome.subject).toBe('Welcome to Multi Lingo AI');
  });

  it('treats en-US as an ordinary Firestore locale, not a special case', async () => {
    await seedLocale('en-US', {
      welcome: { subject: 'Welcome', heading: 'Your practice starts here' },
    });

    const copy = await getEmailCopy('en-US');
    expect(copy.welcome.subject).toBe('Welcome');
    expect(copy.welcome.heading).toBe('Your practice starts here');
  });

  it('falls back to the base copy when the locale has no document yet', async () => {
    await expect(getEmailCopy('xx-XX')).resolves.toEqual(EMAIL_COPY_BASE);
  });

  it('deep-merges over the base so a partly-filled locale degrades key by key', async () => {
    await seedLocale('fr-FR', { welcome: { subject: 'Bienvenue' } });

    const copy = await getEmailCopy('fr-FR');
    expect(copy.welcome.subject).toBe('Bienvenue');
    // Not yet translated — falls through to the base rather than vanishing.
    expect(copy.welcome.body).toBe(EMAIL_COPY_BASE.welcome.body);
    expect(copy.common.app_name).toBe(EMAIL_COPY_BASE.common.app_name);
    expect(copy.payment_failed.subject).toBe(EMAIL_COPY_BASE.payment_failed.subject);
  });

  it('ignores empty strings in a locale document', async () => {
    await seedLocale('de-DE', { welcome: { subject: '' } });
    const copy = await getEmailCopy('de-DE');
    expect(copy.welcome.subject).toBe(EMAIL_COPY_BASE.welcome.subject);
  });

  it('caches a resolved locale instead of reading Firestore per email', async () => {
    await seedLocale('it-IT', { welcome: { subject: 'Benvenuto' } });
    expect((await getEmailCopy('it-IT')).welcome.subject).toBe('Benvenuto');

    // Changing the stored document is not picked up until the TTL lapses —
    // the point of the cache, and the reason tests must clear it.
    await seedLocale('it-IT', { welcome: { subject: 'Cambiato' } });
    expect((await getEmailCopy('it-IT')).welcome.subject).toBe('Benvenuto');

    clearEmailCopyCache();
    expect((await getEmailCopy('it-IT')).welcome.subject).toBe('Cambiato');
  });

  it('never mutates the base copy', async () => {
    const original = EMAIL_COPY_BASE.welcome.subject;
    await seedLocale('es-ES', { welcome: { subject: 'Bienvenido' } });
    await getEmailCopy('es-ES');
    expect(EMAIL_COPY_BASE.welcome.subject).toBe(original);
  });
});

describe('getEmailCopy — three-layer fallback', () => {
  // requested locale -> en-US -> bundled pt-PT
  const ENGLISH = {
    common: { app_name: 'Multi Lingo AI', greeting: 'Hi {{name}},' },
    welcome: { subject: 'Welcome', heading: 'Your practice starts here', body: 'Your account is ready.' },
    payment_failed: { subject: 'Payment problem' },
  };

  it('serves English when the requested locale has no document yet', async () => {
    await seedLocale(FALLBACK_LOCALE, ENGLISH);

    const copy = await getEmailCopy('sv-SE');
    expect(copy.welcome.subject).toBe('Welcome');
    expect(copy.common.greeting).toBe('Hi {{name}},');
  });

  it('fills gaps in a half-translated locale from English, not Portuguese', async () => {
    await seedLocale(FALLBACK_LOCALE, ENGLISH);
    await seedLocale('sv-SE', { welcome: { subject: 'Välkommen' } });

    const copy = await getEmailCopy('sv-SE');
    expect(copy.welcome.subject).toBe('Välkommen');       // its own
    expect(copy.welcome.heading).toBe('Your practice starts here'); // English
    expect(copy.payment_failed.subject).toBe('Payment problem');    // English
  });

  it('falls all the way to the bundled Portuguese when en-US is missing too', async () => {
    await seedLocale('sv-SE', { welcome: { subject: 'Välkommen' } });

    const copy = await getEmailCopy('sv-SE');
    expect(copy.welcome.subject).toBe('Välkommen');
    expect(copy.welcome.body).toBe(EMAIL_COPY_BASE.welcome.body);
  });

  it('does not let the en-US document leak into Portuguese', async () => {
    await seedLocale(FALLBACK_LOCALE, ENGLISH);
    await expect(getEmailCopy(BASE_LOCALE)).resolves.toBe(EMAIL_COPY_BASE);
  });

  it('treats an unset locale as English rather than Portuguese', async () => {
    await seedLocale(FALLBACK_LOCALE, ENGLISH);
    expect((await getEmailCopy(null)).welcome.subject).toBe('Welcome');
    expect((await getEmailCopy(undefined)).welcome.subject).toBe('Welcome');
  });

  it.each(['', '../../etc', 'not a locale', 'x'.repeat(50), 'en_US'])(
    'rejects the malformed locale %p and serves English',
    async (bad) => {
      await seedLocale(FALLBACK_LOCALE, ENGLISH);
      const copy = await getEmailCopy(bad);
      expect(copy.welcome.subject).toBe('Welcome');
    }
  );
});


describe('getEmailCopy — pt-PT comes from the repo, never from Firestore', () => {
  // There is no pt-PT document in Firestore, on purpose. One existed as an
  // abandoned partial seed, the admin email editor used to write to it, and
  // nothing read it. Rather than keep a third copy of these strings in a
  // place no pull request can be gated on, it was deleted — so the guard that
  // matters now is that no code path starts reading one again.

  it('ignores a pt-PT document even if one is put back', async () => {
    await seedLocale(BASE_LOCALE, { welcome: { subject: 'Escrito à mão no Firestore' } });

    // Not a merge, not a fallback: the same object, untouched.
    await expect(getEmailCopy(BASE_LOCALE)).resolves.toBe(EMAIL_COPY_BASE);
    await expect(getEmailCopy('pt')).resolves.toBe(EMAIL_COPY_BASE);
  });

  it('does not let a stray pt-PT document reach another language either', async () => {
    await seedLocale(BASE_LOCALE, { welcome: { heading: 'Escrito à mão' } });
    await seedLocale('sv-SE', { welcome: { subject: 'Välkommen' } });

    const copy = await getEmailCopy('sv-SE');
    expect(copy.welcome.subject).toBe('Välkommen');
    // Falls through to the bundle, not to whatever that document says.
    expect(copy.welcome.heading).toBe(EMAIL_COPY_BASE.welcome.heading);
  });

  it('carries the push reminder copy, which is not email', async () => {
    // It lives under `email.*` because that is where locale resolution already
    // happens; a parallel mechanism would be a second thing to keep filled.
    const copy = await getEmailCopy(BASE_LOCALE);
    expect(copy.reminders.streak_rescue_subject).toBeTruthy();
    expect(copy.reminders.weekly_review_body).toContain('{{days}}');
  });

  it('resolves reminder copy for a translated locale like any other section', async () => {
    await seedLocale('sv-SE', { reminders: { practice_nudge_subject: 'Öva idag?' } });

    const copy = await getEmailCopy('sv-SE');
    expect(copy.reminders.practice_nudge_subject).toBe('Öva idag?');
    expect(copy.reminders.practice_nudge_body).toBe(EMAIL_COPY_BASE.reminders.practice_nudge_body);
  });
});
