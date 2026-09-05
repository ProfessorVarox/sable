import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({
  engineInvoke: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

const mockInvoke = vi.mocked(engineInvoke);

const PRIVATE_KEY = new Uint8Array([1, 2, 3]);

const clientStub = () => {
  const cacheSecretStorageKey = vi.fn<(keyId: string, keyInfo: unknown, key: Uint8Array) => void>();
  const store = vi.fn<(name: string, value: string) => Promise<void>>(async () => undefined);
  const mx = {
    http: { authedRequest: vi.fn<(...args: never[]) => Promise<string>>(async () => '{}') },
    cryptoCallbacks: { cacheSecretStorageKey },
    secretStorage: {
      getDefaultKeyId: async () => null,
      addKey: async () => ({
        keyId: 'KEYID',
        keyInfo: { algorithm: 'm.secret_storage.v1.aes-hmac-sha2' },
      }),
      setDefaultKeyId: async () => undefined,
      hasKey: async () => true,
      get: async () => null,
      store,
    },
  } as unknown as MatrixClient;
  return { mx, cacheSecretStorageKey, store };
};

describe('bootstrapSecretStorage', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('caches the key it just created so storing secrets can find it', async () => {
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'exportCrossSigningKeys') return { masterKey: 'msk' };
      return null;
    });
    const { mx, cacheSecretStorageKey } = clientStub();

    await new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' }).bootstrapSecretStorage({
      createSecretStorageKey: async () => ({
        privateKey: PRIVATE_KEY,
        encodedPrivateKey: 'encoded',
      }),
    });

    expect(cacheSecretStorageKey).toHaveBeenCalledWith(
      'KEYID',
      { algorithm: 'm.secret_storage.v1.aes-hmac-sha2' },
      PRIVATE_KEY
    );
  });
});
