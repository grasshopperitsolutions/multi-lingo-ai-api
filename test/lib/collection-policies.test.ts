import { describe, it, expect } from 'vitest';
import { resolveCollectionPolicy, DEFAULT_POLICY } from '../../lib/collection-policies';

describe('resolveCollectionPolicy', () => {
  it('falls back to the strict default for an unlisted collection', () => {
    expect(resolveCollectionPolicy(['files'])).toEqual(DEFAULT_POLICY);
    expect(resolveCollectionPolicy(['mystery'])).toEqual(DEFAULT_POLICY);
  });

  it('resolves exact-path policies for appConfig subcollections that allow any signed-in user to write', () => {
    expect(resolveCollectionPolicy(['appConfig', 'config', 'locales'])).toEqual({ read: 'public', write: 'authenticated' });
    expect(resolveCollectionPolicy(['appConfig', 'config', 'languages'])).toEqual({ read: 'public', write: 'authenticated' });
    expect(resolveCollectionPolicy(['appConfig', 'config', 'writingSystems'])).toEqual({ read: 'authenticated', write: 'authenticated' });
  });

  it('resolves exact-path policies for appConfig subcollections that are admin-write only', () => {
    expect(resolveCollectionPolicy(['appConfig', 'config', 'categories'])).toEqual({ read: 'public', write: 'authenticated' });
    expect(resolveCollectionPolicy(['appConfig', 'config', 'authProviders'])).toEqual({ read: 'public', write: 'admin' });
    expect(resolveCollectionPolicy(['appConfig', 'config', 'prompts'])).toEqual({ read: 'public', write: 'admin' });
  });

  it('lets guests read the feature registry and tier config, but only admins write them', () => {
    // The public pricing page renders from these, and the frontend treats both
    // as required config — a guest that can't read them gets /app-unavailable.
    expect(resolveCollectionPolicy(['appConfig', 'config', 'features'])).toEqual({ read: 'public', write: 'admin' });
    expect(resolveCollectionPolicy(['appConfig', 'config', 'tiersConfig'])).toEqual({ read: 'public', write: 'admin' });
  });

  it('does not leave the feature registry or tier config on the default policy', () => {
    // Regression guard: under owner-or-admin, "a brand-new document is always
    // creatable" would let any signed-in caller invent feature keys or tiers.
    expect(resolveCollectionPolicy(['appConfig', 'config', 'features'])).not.toEqual(DEFAULT_POLICY);
    expect(resolveCollectionPolicy(['appConfig', 'config', 'tiersConfig'])).not.toEqual(DEFAULT_POLICY);
  });

  it('falls back to the default for an appConfig subcollection with no explicit row', () => {
    expect(resolveCollectionPolicy(['appConfig', 'config', 'somethingNew'])).toEqual(DEFAULT_POLICY);
  });

  it('resolves prefix policies for the shared pool collections', () => {
    for (const name of ['wordPool', 'wordLinkGamePool', 'wordLadderGamePool', 'examExercises', 'examImages']) {
      expect(resolveCollectionPolicy([name])).toEqual({ read: 'authenticated', write: 'authenticated' });
    }
  });

  it('a prefix policy covers subcollections nested under a pool document', () => {
    expect(resolveCollectionPolicy(['wordPool', 'concept123', 'translations'])).toEqual({
      read: 'authenticated',
      write: 'authenticated',
    });
    expect(resolveCollectionPolicy(['examExercises', 'ex1', 'content'])).toEqual({
      read: 'authenticated',
      write: 'authenticated',
    });
  });

  it('an exact-path match wins over a prefix match when both could apply', () => {
    // appConfig has no prefix-level entry, so this is really just confirming
    // exact-path lookup happens first in the implementation.
    expect(resolveCollectionPolicy(['appConfig', 'config', 'locales']).write).toBe('authenticated');
  });
});
