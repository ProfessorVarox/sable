import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from '$types/matrix-sdk';

const tauriApi = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  convertFileSrc: vi.fn<(url: string, protocol: string) => string>(
    (url: string, protocol: string) => `${protocol}://${url}`
  ),
}));

const mediaTransport = vi.hoisted(() => ({
  fetchMediaBlob: vi.fn<(url: string) => Promise<Blob>>(),
  getCurrentMediaSessionScope: vi.fn<() => string>(() => '@user:example.com'),
}));

const reactions = vi.hoisted(() => ({
  getEventReactions: vi.fn<() => unknown>(),
}));

vi.mock('@tauri-apps/api/core', () => tauriApi);
vi.mock('./mediaTransport', () => mediaTransport);
vi.mock('./room/relations', () => reactions);

const { mxcUrlToHttp, rewriteAuthenticatedMediaUrl, toggleReaction } = await import('./matrix');

describe('rewriteAuthenticatedMediaUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for null input', () => {
    tauriApi.isTauri.mockReturnValue(true);
    expect(rewriteAuthenticatedMediaUrl(null)).toBeNull();
  });

  it('passes through non-Tauri without rewriting', () => {
    tauriApi.isTauri.mockReturnValue(false);
    const url = 'https://matrix.example.org/_matrix/client/v1/media/download/example.org/abc';
    expect(rewriteAuthenticatedMediaUrl(url)).toBe(url);
    expect(tauriApi.convertFileSrc).not.toHaveBeenCalled();
  });

  it('passes through plain https URLs that are not authenticated media', () => {
    tauriApi.isTauri.mockReturnValue(true);
    const url = 'https://example.org/avatar.png';
    expect(rewriteAuthenticatedMediaUrl(url)).toBe(url);
    expect(tauriApi.convertFileSrc).not.toHaveBeenCalled();
  });

  it('rewrites authenticated-media download URLs under Tauri', () => {
    tauriApi.isTauri.mockReturnValue(true);
    const url = 'https://matrix.example.org/_matrix/client/v1/media/download/example.org/abc123';
    expect(rewriteAuthenticatedMediaUrl(url)).toBe(
      `sable-media://${url}?__sable_media_cache=3&__sable_media_session=%40user%3Aexample.com`
    );
    expect(tauriApi.convertFileSrc).toHaveBeenCalledWith(url, 'sable-media');
  });

  it('rewrites authenticated-media thumbnail URLs under Tauri', () => {
    tauriApi.isTauri.mockReturnValue(true);
    const url =
      'https://matrix.example.org/_matrix/client/v1/media/thumbnail/example.org/abc123?width=96&height=96&method=crop';
    expect(rewriteAuthenticatedMediaUrl(url)).toBe(
      `sable-media://${url}&__sable_media_cache=3&__sable_media_session=%40user%3Aexample.com`
    );
  });

  it.each([
    '/_matrix/media/v3/download/example.org/abc123',
    '/_matrix/media/v3/thumbnail/example.org/abc123?width=96&height=96&method=crop',
    '/_matrix/media/r0/download/example.org/abc123',
    '/_matrix/media/r0/thumbnail/example.org/abc123?width=96&height=96&method=crop',
  ])('rewrites legacy media paths under Tauri: %s', (path) => {
    tauriApi.isTauri.mockReturnValue(true);
    const url = `https://matrix.example.org${path}`;
    const separator = url.includes('?') ? '&' : '?';
    expect(rewriteAuthenticatedMediaUrl(url)).toBe(
      `sable-media://${url}${separator}__sable_media_cache=3&__sable_media_session=%40user%3Aexample.com`
    );
  });

  it('does not rewrite unrelated Matrix media URLs', () => {
    tauriApi.isTauri.mockReturnValue(true);
    const url = 'https://matrix.example.org/_matrix/media/v3/config';
    expect(rewriteAuthenticatedMediaUrl(url)).toBe(url);
    expect(tauriApi.convertFileSrc).not.toHaveBeenCalled();
  });

  it.each([
    'https://example.org/avatar.png?next=/_matrix/media/v3/download/example.org/abc123',
    'https://example.org/avatar.png#/_matrix/media/r0/thumbnail/example.org/abc123',
  ])('does not rewrite a media path only present in query or hash: %s', (url) => {
    tauriApi.isTauri.mockReturnValue(true);
    expect(rewriteAuthenticatedMediaUrl(url)).toBe(url);
    expect(tauriApi.convertFileSrc).not.toHaveBeenCalled();
  });

  it('passes through already-rewritten sable-media:// URLs', () => {
    tauriApi.isTauri.mockReturnValue(true);
    const url =
      'sable-media://https://matrix.example.org/_matrix/client/v1/media/download/example.org/abc123';
    expect(rewriteAuthenticatedMediaUrl(url)).toBe(
      `${url}?__sable_media_cache=3&__sable_media_session=%40user%3Aexample.com`
    );
    expect(tauriApi.convertFileSrc).not.toHaveBeenCalled();
  });
});

describe('toggleReaction', () => {
  it('redacts the existing reaction from the current user', () => {
    const reaction = {
      getId: () => '$reaction',
      getSender: () => '@me:example.org',
    };
    reactions.getEventReactions.mockReturnValue({
      getSortedAnnotationsByKey: () => [['👍', new Set([reaction])]],
    });
    const mx = {
      getUserId: () => '@me:example.org',
      redactEvent: vi.fn<(roomId: string, eventId: string) => void>(),
      sendEvent: vi.fn<(...args: unknown[]) => void>(),
    } as unknown as MatrixClient;
    const room = {
      roomId: '!room:example.org',
      getUnfilteredTimelineSet: vi.fn<() => unknown>(),
    };

    toggleReaction(mx, room as never, '$message', '👍');

    expect(mx.redactEvent).toHaveBeenCalledWith('!room:example.org', '$reaction');
    expect(mx.sendEvent).not.toHaveBeenCalled();
  });
});

describe('mxcUrlToHttp', () => {
  it('rewrites SDK legacy media URLs under Tauri without useAuthentication', () => {
    tauriApi.isTauri.mockReturnValue(true);
    const legacyUrl = 'https://matrix.example.org/_matrix/media/v3/download/example.org/video';
    const mx = {
      mxcUrlToHttp: vi.fn<() => string>(() => legacyUrl),
    } as unknown as MatrixClient;

    expect(mxcUrlToHttp(mx, 'mxc://example.org/video', false)).toBe(
      `sable-media://${legacyUrl}?__sable_media_cache=3&__sable_media_session=%40user%3Aexample.com`
    );
  });
});
