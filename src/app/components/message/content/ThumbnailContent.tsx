import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo } from 'react';
import { Box, Spinner } from 'folds';
import type { IThumbnailContent } from '$types/matrix/common';
import { useMatrixClient } from '$hooks/useMatrixClient';
import { AsyncStatus, useAsyncCallback } from '$hooks/useAsyncCallback';
import {
  decryptFile,
  downloadEncryptedMedia,
  mxcUrlToHttp,
  rewriteAuthenticatedMediaUrl,
} from '$utils/matrix';
import { setMediaEncryption } from '$utils/tauriMediaEncryption';
import { isTauri } from '@tauri-apps/api/core';
import { useMediaAuthentication } from '$hooks/useMediaAuthentication';
import { useRenderableMediaUrl } from '$hooks/useRenderableMediaUrl';
import { useRevokeObjectURL } from '$hooks/useObjectURL';
import { FALLBACK_MIMETYPE } from '$utils/mimeTypes';

export type ThumbnailContentProps = {
  info: IThumbnailContent;
  renderImage: (src: string) => ReactNode;
};
export function ThumbnailContent({ info, renderImage }: ThumbnailContentProps) {
  const mx = useMatrixClient();
  const useAuthentication = useMediaAuthentication();

  const encInfo = info.thumbnail_file;
  const thumbMxcUrl = encInfo?.url ?? info.thumbnail_url;

  const rawMediaUrl = useMemo(() => {
    if (typeof thumbMxcUrl !== 'string') return undefined;
    return mxcUrlToHttp(mx, thumbMxcUrl, useAuthentication) ?? undefined;
  }, [mx, thumbMxcUrl, useAuthentication]);

  const resolvedMediaUrl = useRenderableMediaUrl(encInfo ? undefined : rawMediaUrl);

  const [thumbSrcState, loadThumbSrc] = useAsyncCallback(
    useCallback(async () => {
      const thumbInfo = info.thumbnail_info;
      if (typeof thumbMxcUrl !== 'string' || typeof thumbInfo?.mimetype !== 'string') {
        throw new Error('Failed to load thumbnail');
      }
      if (encInfo) {
        if (!rawMediaUrl) throw new Error('Invalid media URL');
        if (isTauri()) {
          await setMediaEncryption(rawMediaUrl, encInfo, thumbInfo.mimetype ?? FALLBACK_MIMETYPE);
          return rewriteAuthenticatedMediaUrl(rawMediaUrl)!;
        }
        const fileContent = await downloadEncryptedMedia(rawMediaUrl, (encBuf) =>
          decryptFile(encBuf, thumbInfo.mimetype ?? FALLBACK_MIMETYPE, encInfo)
        );
        return URL.createObjectURL(fileContent);
      }
      return resolvedMediaUrl ?? rawMediaUrl ?? thumbMxcUrl;
    }, [info, thumbMxcUrl, rawMediaUrl, resolvedMediaUrl, encInfo])
  );

  useEffect(() => {
    loadThumbSrc();
  }, [loadThumbSrc]);

  useRevokeObjectURL(
    encInfo && thumbSrcState.status === AsyncStatus.Success ? thumbSrcState.data : undefined
  );

  if (thumbSrcState.status === AsyncStatus.Success) return renderImage(thumbSrcState.data);

  if (thumbSrcState.status === AsyncStatus.Loading) {
    return (
      <Box alignItems="Center" justifyContent="Center">
        <Spinner variant="Secondary" />
      </Box>
    );
  }

  return null;
}
