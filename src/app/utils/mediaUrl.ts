import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import type { MatrixClient } from '$types/matrix-sdk';
import { getCurrentMediaSessionScope } from './mediaTransport';

const TAURI_MEDIA_CACHE_VERSION = '__sable_media_cache=3';
const TAURI_MEDIA_PATH_PREFIXES = [
  '/_matrix/client/v1/media/',
  '/_matrix/media/v3/download/',
  '/_matrix/media/v3/thumbnail/',
  '/_matrix/media/r0/download/',
  '/_matrix/media/r0/thumbnail/',
];

export const rewriteAuthenticatedMediaUrl = (httpUrl: string | null): string | null => {
  if (!httpUrl) return null;
  if (!isTauri()) return httpUrl;
  const sourceUrl = httpUrl.startsWith('sable-media://')
    ? httpUrl.slice('sable-media://'.length)
    : httpUrl;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    return httpUrl;
  }
  if (
    (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') ||
    parsedUrl.origin === 'null' ||
    !TAURI_MEDIA_PATH_PREFIXES.some((path) => parsedUrl.pathname.startsWith(path))
  ) {
    return httpUrl;
  }
  if (httpUrl.includes(TAURI_MEDIA_CACHE_VERSION)) return httpUrl;
  const mediaUrl = httpUrl.startsWith('sable-media://')
    ? httpUrl
    : convertFileSrc(httpUrl, 'sable-media');
  // Session-scoped so the cacheable response is never shared across accounts.
  const sessionScope = encodeURIComponent(getCurrentMediaSessionScope());
  const separator = mediaUrl.includes('?') ? '&' : '?';
  return `${mediaUrl}${separator}${TAURI_MEDIA_CACHE_VERSION}&__sable_media_session=${sessionScope}`;
};

const TAURI_MEDIA_RETRY_FRAGMENT = '__sable_media_retry';
const TAURI_MEDIA_OUTER_QUERY_PARAMS = ['__sable_media_cache', '__sable_media_session'];
const TAURI_MEDIA_PROTOCOL = 'sable-media://';
const TAURI_MEDIA_LOCALHOST = 'localhost';
const TAURI_MEDIA_LOCALHOST_HOST = 'sable-media.localhost';

export const getTauriMediaSourceUrl = (mediaUrl: string): string | undefined => {
  if (mediaUrl.startsWith(TAURI_MEDIA_PROTOCOL)) {
    const wrappedUrl = mediaUrl.slice(TAURI_MEDIA_PROTOCOL.length);

    if (wrappedUrl.startsWith(`${TAURI_MEDIA_LOCALHOST}/`)) {
      try {
        const parsedUrl = new URL(mediaUrl);
        if (parsedUrl.hostname !== TAURI_MEDIA_LOCALHOST) return undefined;
        return decodeURIComponent(parsedUrl.pathname.slice(1));
      } catch {
        return undefined;
      }
    }

    return wrappedUrl;
  }

  try {
    const parsedUrl = new URL(mediaUrl);
    if (
      (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') &&
      parsedUrl.hostname === TAURI_MEDIA_LOCALHOST_HOST
    ) {
      return decodeURIComponent(parsedUrl.pathname.slice(1));
    }
  } catch {
    return undefined;
  }

  return mediaUrl;
};

// Embeds a retry revision as a fragment on the inner http(s) target (stripping the
// outer cache/session markers, which the rewrite re-adds). The fragment makes Rust's
// cache_key(scope, target) distinct but is stripped natively before the upstream
// request and the encryption lookup. Undefined for the first attempt, outside Tauri,
// or when there is no http(s) inner target (e.g. blob: URLs).
export const getTauriMediaRetryTarget = (
  mediaUrl: string,
  revision: number
): string | undefined => {
  if (revision <= 0 || !isTauri()) return undefined;
  const innerTarget = getTauriMediaSourceUrl(mediaUrl);
  if (!innerTarget) return undefined;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(innerTarget);
  } catch {
    return undefined;
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return undefined;
  TAURI_MEDIA_OUTER_QUERY_PARAMS.forEach((param) => parsedUrl.searchParams.delete(param));
  parsedUrl.hash = `${TAURI_MEDIA_RETRY_FRAGMENT}=${revision}`;
  return parsedUrl.toString();
};

export const addTauriMediaRetryRevision = (mediaUrl: string, revision: number): string => {
  const target = getTauriMediaRetryTarget(mediaUrl, revision);
  if (!target) return mediaUrl;
  return rewriteAuthenticatedMediaUrl(target) ?? mediaUrl;
};

export const mxcUrlToHttp = (
  mx: MatrixClient,
  mxcUrl: string,
  useAuthentication?: boolean,
  width?: number,
  height?: number,
  resizeMethod?: string,
  allowDirectLinks?: boolean
): string | null => {
  const httpUrl = mx.mxcUrlToHttp(
    mxcUrl.replace(/^["']|["']$/g, ''),
    width,
    height,
    resizeMethod,
    allowDirectLinks,
    undefined,
    useAuthentication
  );

  if (httpUrl && isTauri()) {
    return rewriteAuthenticatedMediaUrl(httpUrl);
  }
  return httpUrl;
};
