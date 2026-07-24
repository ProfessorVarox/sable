import { isTauri, invoke } from '@tauri-apps/api/core';
import type { EncryptedAttachmentInfo } from 'browser-encrypt-attachment';

export const setMediaEncryption = async (
  url: string,
  encInfo: EncryptedAttachmentInfo,
  mimeType: string
): Promise<void> => {
  if (!isTauri()) return;

  const jwkKey = encInfo.key as JsonWebKey;
  if (!jwkKey.k) return;

  await invoke('set_media_encryption', {
    url,
    key: jwkKey.k,
    iv: encInfo.iv,
    sha256: encInfo.hashes.sha256,
    version: encInfo.v ?? '',
    mimeType,
  });
};
