import type { SecretStorageKey, ServerSideSecretStorage } from 'matrix-js-sdk/lib/secret-storage';

export const secretStorageCanAccessSecrets = async (
  secretStorage: ServerSideSecretStorage,
  secretNames: SecretStorageKey[]
): Promise<boolean> => {
  const defaultKeyId = await secretStorage.getDefaultKeyId();
  if (!defaultKeyId) return false;

  const stored = await Promise.all(
    secretNames.map(async (name) => (await secretStorage.isStored(name)) ?? {})
  );

  return stored.every((record) => defaultKeyId in record);
};
