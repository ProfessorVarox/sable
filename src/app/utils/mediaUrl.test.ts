// oxlint-disable typescript/no-explicit-any
import { describe, expect, it, vi, afterEach } from 'vitest';

const hoistedGetSessionScope = vi.hoisted(() => vi.fn<() => string>(() => 'session_abc'));
const hoistedIsTauri = vi.hoisted(() => vi.fn<() => boolean>(() => false));
const hoistedConvertFileSrc = vi.hoisted(() =>
  vi.fn<(url: string, protocol: string) => string>(
    (url: string, protocol: string) => `${protocol}://${url}`
  )
);

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: hoistedIsTauri,
  convertFileSrc: hoistedConvertFileSrc,
}));

vi.mock('./mediaTransport', () => ({
  getCurrentMediaSessionScope: hoistedGetSessionScope,
}));

import {
  addTauriMediaRetryRevision,
  getTauriMediaSourceUrl,
  getTauriMediaRetryTarget,
  rewriteAuthenticatedMediaUrl,
} from './mediaUrl';

afterEach(() => {
  hoistedIsTauri.mockReset();
  hoistedIsTauri.mockReturnValue(false);
  hoistedGetSessionScope.mockReset();
  hoistedGetSessionScope.mockReturnValue('session_abc');
});

const VERSION_SNIPPET = '__sable_media_cache=3';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('rewriteAuthenticatedMediaUrl', () => {
  describe('non-Tauri passthrough', () => {
    it('returns the URL unchanged when not in Tauri', () => {
      const url = 'https://matrix.example.com/_matrix/media/v3/download/example.com/abc123';
      expect(rewriteAuthenticatedMediaUrl(url)).toBe(url);
    });

    it('returns null for null input (non-Tauri)', () => {
      expect(rewriteAuthenticatedMediaUrl(null)).toBeNull();
    });
  });

  describe('null / falsy input', () => {
    it('returns null for null input in Tauri', () => {
      hoistedIsTauri.mockReturnValue(true);
      expect(rewriteAuthenticatedMediaUrl(null)).toBeNull();
    });
  });

  describe('authenticated prefix rewriting (Tauri)', () => {
    const prefixes = [
      '/_matrix/client/v1/media/',
      '/_matrix/media/v3/download/',
      '/_matrix/media/v3/thumbnail/',
      '/_matrix/media/r0/download/',
      '/_matrix/media/r0/thumbnail/',
    ];

    it.each(prefixes)('rewrites URLs starting with %s', (prefix) => {
      hoistedIsTauri.mockReturnValue(true);
      const url = `https://matrix.example.com${prefix}example.com/abc123`;
      const result = rewriteAuthenticatedMediaUrl(url);
      expect(result).not.toBeNull();
      expect(result).toContain('sable-media://');
      expect(result).toContain(VERSION_SNIPPET);
      expect(result).toContain('__sable_media_session=session_abc');
    });
  });

  describe('idempotency', () => {
    it('returns an already-rewritten URL unchanged', () => {
      hoistedIsTauri.mockReturnValue(true);
      const url = 'https://matrix.example.com/_matrix/media/v3/download/example.com/abc123';
      const first = rewriteAuthenticatedMediaUrl(url) as string;
      const second = rewriteAuthenticatedMediaUrl(first);
      expect(second).toBe(first);
    });

    it('returns an already-rewritten sable-media:// URL unchanged', () => {
      hoistedIsTauri.mockReturnValue(true);
      const alreadyRewritten =
        'sable-media://https://matrix.example.com/_matrix/media/v3/download/example.com/abc123';
      const withVersion = `${alreadyRewritten}?${VERSION_SNIPPET}&__sable_media_session=session_abc`;
      expect(rewriteAuthenticatedMediaUrl(withVersion)).toBe(withVersion);
    });
  });

  describe('session scoping', () => {
    it('includes a session-scoped token in the rewritten URL', () => {
      hoistedIsTauri.mockReturnValue(true);
      const url = 'https://matrix.example.com/_matrix/media/v3/download/example.com/abc123';
      const result = rewriteAuthenticatedMediaUrl(url);
      expect(result).toContain('__sable_media_session=session_abc');
    });

    it('produces different URLs for different session scopes', () => {
      hoistedIsTauri.mockReturnValue(true);
      const url = 'https://matrix.example.com/_matrix/media/v3/download/example.com/abc123';

      hoistedGetSessionScope.mockReturnValue('session_alice');
      const aliceUrl = rewriteAuthenticatedMediaUrl(url);

      hoistedGetSessionScope.mockReturnValue('session_bob');
      const bobUrl = rewriteAuthenticatedMediaUrl(url);

      expect(aliceUrl).not.toBeNull();
      expect(bobUrl).not.toBeNull();
      expect(aliceUrl).not.toEqual(bobUrl);
      expect(aliceUrl).toContain('__sable_media_session=session_alice');
      expect(bobUrl).toContain('__sable_media_session=session_bob');
    });
  });

  describe('non-media URLs', () => {
    it('leaves non-Matrix URLs unchanged in Tauri', () => {
      hoistedIsTauri.mockReturnValue(true);
      const url = 'https://example.com/some/image.png';
      expect(rewriteAuthenticatedMediaUrl(url)).toBe(url);
    });

    it('leaves invalid URLs unchanged', () => {
      hoistedIsTauri.mockReturnValue(true);
      const url = 'not-a-url';
      expect(rewriteAuthenticatedMediaUrl(url)).toBe(url);
    });

    it('leaves non-http/https protocol URLs unchanged', () => {
      hoistedIsTauri.mockReturnValue(true);
      const url = 'ftp://matrix.example.com/_matrix/media/v3/download/example.com/abc123';
      expect(rewriteAuthenticatedMediaUrl(url)).toBe(url);
    });
  });
});

describe('addTauriMediaRetryRevision', () => {
  const INNER = 'https://matrix.example.com/_matrix/client/v1/media/download/example.com/abc123';
  const REWRITTEN = `sable-media://${INNER}?__sable_media_cache=3&__sable_media_session=session_abc`;

  afterEach(() => {
    hoistedConvertFileSrc.mockImplementation(
      (url: string, protocol: string) => `${protocol}://${url}`
    );
  });

  it('is a no-op for the first attempt and outside Tauri', () => {
    hoistedIsTauri.mockReturnValue(true);
    expect(addTauriMediaRetryRevision(REWRITTEN, 0)).toBe(REWRITTEN);
    hoistedIsTauri.mockReturnValue(false);
    expect(addTauriMediaRetryRevision(REWRITTEN, 2)).toBe(REWRITTEN);
  });

  it('leaves URLs without an http(s) inner target unchanged (e.g. blob: URLs)', () => {
    hoistedIsTauri.mockReturnValue(true);
    const blob = 'blob:https://app.local/0000-1111';
    expect(addTauriMediaRetryRevision(blob, 1)).toBe(blob);
  });

  it('encodes the retry fragment into the wrapped URI scheme path', () => {
    hoistedIsTauri.mockReturnValue(true);
    // Real convertFileSrc percent-encodes the target into the URI path.
    hoistedConvertFileSrc.mockImplementation(
      (url, protocol) => `${protocol}://localhost/${encodeURIComponent(url)}`
    );

    const revised = addTauriMediaRetryRevision(REWRITTEN, 1)!;

    expect(revised).toContain('__sable_media_cache=3');
    expect(revised).toContain('__sable_media_session=session_abc');
    // The decoded scheme path is the `target` Rust feeds into cache_key(scope, target).
    const schemePath = revised.slice('sable-media://localhost/'.length).split('?')[0];
    expect(decodeURIComponent(schemePath ?? '')).toBe(`${INNER}#__sable_media_retry=1`);
  });

  it('replaces an existing retry fragment instead of stacking', () => {
    hoistedIsTauri.mockReturnValue(true);
    const first = addTauriMediaRetryRevision(REWRITTEN, 1);
    const second = addTauriMediaRetryRevision(first, 2);
    expect(second).toBe(addTauriMediaRetryRevision(REWRITTEN, 2));
  });

  it('keeps rewriteAuthenticatedMediaUrl idempotent over revised URLs', () => {
    hoistedIsTauri.mockReturnValue(true);
    const revised = addTauriMediaRetryRevision(REWRITTEN, 1);
    expect(rewriteAuthenticatedMediaUrl(revised)).toBe(revised);
    expect(revised).not.toBeUndefined();
  });
});

describe('getTauriMediaRetryTarget', () => {
  const WRAPPED =
    'sable-media://https://matrix.example.com/_matrix/client/v1/media/download/example.com/abc123?__sable_media_cache=3&__sable_media_session=session_abc';
  const INNER = 'https://matrix.example.com/_matrix/client/v1/media/download/example.com/abc123';
  const WRAPPED_TARGETS = [
    WRAPPED,
    `sable-media://localhost/${encodeURIComponent(INNER)}?__sable_media_cache=3&__sable_media_session=session_abc`,
    `https://sable-media.localhost/${encodeURIComponent(INNER)}?__sable_media_cache=3&__sable_media_session=session_abc`,
    `http://sable-media.localhost/${encodeURIComponent(INNER)}?__sable_media_cache=3&__sable_media_session=session_abc`,
  ];

  it('returns undefined for the first attempt and outside Tauri', () => {
    hoistedIsTauri.mockReturnValue(true);
    expect(getTauriMediaRetryTarget(WRAPPED, 0)).toBeUndefined();
    hoistedIsTauri.mockReturnValue(false);
    expect(getTauriMediaRetryTarget(WRAPPED, 1)).toBeUndefined();
  });

  it.each(WRAPPED_TARGETS)(
    'returns the revised http target for encryption registration: %s',
    (url) => {
      hoistedIsTauri.mockReturnValue(true);
      expect(getTauriMediaRetryTarget(url, 1)).toBe(`${INNER}#__sable_media_retry=1`);
    }
  );
});

describe('getTauriMediaSourceUrl', () => {
  it('unwraps the Android protocol URL to its Matrix media source', () => {
    const source = 'https://matrix.example.com/_matrix/client/v1/media/download/example.com/abc123';
    const url = `https://sable-media.localhost/${encodeURIComponent(source)}?__sable_media_cache=3`;

    expect(getTauriMediaSourceUrl(url)).toBe(source);
  });

  it('passes ordinary URLs through unchanged', () => {
    const url = 'https://example.org/image.png';
    expect(getTauriMediaSourceUrl(url)).toBe(url);
  });
});
