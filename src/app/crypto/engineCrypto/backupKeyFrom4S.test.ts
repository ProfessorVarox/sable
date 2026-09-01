import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as RustSdkCryptoJs from '@matrix-org/matrix-sdk-crypto-wasm';
import { DecryptionKeyDoesNotMatchError } from 'matrix-js-sdk/lib/crypto-api';
import type { MatrixClient } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({
  engineInvoke: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

const mockInvoke = vi.mocked(engineInvoke);

const clientWith = (encoded: string, publicKey: string) =>
  ({
    secretStorage: { get: async () => encoded },
    http: {
      authedRequest: vi.fn<(...args: never[]) => Promise<unknown>>(async () => ({
        version: '3',
        algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
        auth_data: { public_key: publicKey },
      })),
    },
  }) as unknown as MatrixClient;

describe('loadSessionBackupPrivateKeyFromSecretStorage', () => {
  beforeAll(() => RustSdkCryptoJs.initAsync());
  beforeEach(() => mockInvoke.mockReset().mockResolvedValue(null));

  it('rejects a stored key that does not match the server backup', async () => {
    const stored = RustSdkCryptoJs.BackupDecryptionKey.createRandomKey();
    const other = RustSdkCryptoJs.BackupDecryptionKey.createRandomKey();
    const mx = clientWith(stored.toBase64(), other.megolmV1PublicKey.publicKeyBase64);

    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });

    await expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage()).rejects.toBeInstanceOf(
      DecryptionKeyDoesNotMatchError
    );
    expect(mockInvoke.mock.calls.some(([, m]) => m === 'saveBackupDecryptionKey')).toBe(false);
  });

  it('accepts a stored key that matches the server backup', async () => {
    const stored = RustSdkCryptoJs.BackupDecryptionKey.createRandomKey();
    const mx = clientWith(stored.toBase64(), stored.megolmV1PublicKey.publicKeyBase64);

    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });

    await expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage()).resolves.toBeUndefined();
    expect(mockInvoke.mock.calls.some(([, m]) => m === 'saveBackupDecryptionKey')).toBe(true);
  });
});
