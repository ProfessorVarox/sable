import { describe, expect, it } from 'vitest';

import {
  extractCircumfixProxyTagsFromKey,
  parsePerMessageProfileProxyAssociation,
  migratePmpProxyAssociation,
  type PerMessageProfileProxyAssociationV2,
  type PerMessageProfileProxyAssociationV1,
  proxyNeedsMigration,
  createProxyKey,
} from './usePerMessageProfile';

describe('migratePerMessageProfileProxyAssociation', () => {
  it('turns a key into a prefix', () => {
    const key = 'j;text';
    const migrated = extractCircumfixProxyTagsFromKey(key);

    expect(migrated).toStrictEqual({ prefix: 'j;', suffix: undefined });
  });
  it('turns a key into a suffix', () => {
    const key = 'text-J';
    const migrated = extractCircumfixProxyTagsFromKey(key);

    expect(migrated).toStrictEqual({ prefix: undefined, suffix: '-J' });
  });
  it('turns a key into a circumfix', () => {
    const key = '[text]';
    const migrated = extractCircumfixProxyTagsFromKey(key);

    expect(migrated).toStrictEqual({ prefix: '[', suffix: ']' });
  });
  it('testing whitespace in proxy tags', () => {
    const key = 'J: text -J';
    const migrated = extractCircumfixProxyTagsFromKey(key);

    expect(migrated).toStrictEqual({ prefix: 'J: ', suffix: ' -J' });
  });
  it('atypical proxy tag format 1', () => {
    const key = '_text -j';
    const migrated = extractCircumfixProxyTagsFromKey(key);

    expect(migrated).toStrictEqual({ prefix: '_', suffix: ' -j' });
  });

  it('noop migration', () => {
    const v2: PerMessageProfileProxyAssociationV2 = {
      profileId: 'foo',
      prefix: '[',
      suffix: ']',
    };
    const migrated = migratePmpProxyAssociation('[text]', v2);

    expect(migrated).toStrictEqual(v2);
  });

  it('simple migration', () => {
    const v1: PerMessageProfileProxyAssociationV1 = {
      profileId: 'foo',
      regexString: 'bar',
    };
    const migrated = migratePmpProxyAssociation('[text]', v1);

    expect(migrated).toStrictEqual({
      profileId: 'foo',
      prefix: '[',
      suffix: ']',
    });
  });

  it('needsMigration positive test', () => {
    const v1: PerMessageProfileProxyAssociationV1 = {
      profileId: 'foo',
      regexString: 'bar',
    };
    const checked = proxyNeedsMigration(v1);

    expect(checked).toBe(true);
  });

  it('needsMigration negative test', () => {
    const v2: PerMessageProfileProxyAssociationV2 = {
      profileId: 'foo',
      prefix: '[',
      suffix: ']',
    };
    const checked = proxyNeedsMigration(v2);

    expect(checked).toBe(false);
  });

  it('create prefix proxy key', () => {
    const key = createProxyKey('j;', undefined);
    expect(key).toBe('j;text');
  });
  it('create suffix proxy key', () => {
    const key = createProxyKey(undefined, '-J');
    expect(key).toBe('text-J');
  });
  it('create circumfix proxy key', () => {
    const key = createProxyKey('[', ']');
    expect(key).toBe('[text]');
  });
  it('check proxy key does not do falsy stuff', () => {
    const key = createProxyKey('false', '0');
    expect(key).toBe('falsetext0');
  });
});

describe('parsePerMessageProfileProxyAssociation', () => {
  it('parses a regex string with flags (RegExp#toString form)', () => {
    const assoc = {
      profileId: 'p1',
      regexString: '/^\\[text\\] (.+)$/i',
      setAt: 123,
    };

    const parsed = parsePerMessageProfileProxyAssociation(assoc);
    expect(parsed.profileId).toBe('p1');
    expect(parsed.setAt).toBe(123);
    expect(parsed.regex.test('[text] Hello')).toBe(true);
    expect(parsed.regex.test('[TEXT] hello')).toBe(true); // i flag
  });

  it('parses a regex string without flags', () => {
    const assoc = {
      profileId: 'p1',
      regexString: '/^\\[(.+)\\]$/',
    };

    const parsed = parsePerMessageProfileProxyAssociation(assoc);
    expect(parsed.regex.test('[ok]')).toBe(true);
    expect(parsed.regex.test('[no] trailing')).toBe(false);
  });
});
