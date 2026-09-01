import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({
  engineInvoke: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

const mockInvoke = vi.mocked(engineInvoke);

const notFound = Object.assign(new Error('no backup'), { errcode: 'M_NOT_FOUND' });

const setup = () => {
  const versionGets: unknown[] = [];
  const authedRequest = vi.fn<(...args: never[]) => Promise<unknown>>(
    async (_method: unknown, url: unknown) => {
      if (url === '/room_keys/version') {
        versionGets.push(url);
        throw notFound;
      }
      return {};
    }
  );
  const mx = {
    http: { authedRequest },
    secretStorage: { isStored: async () => null },
  } as unknown as MatrixClient;
  return { mx, versionGets };
};

describe('key backup info caching', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('serves repeated getKeyBackupInfo calls from one request', async () => {
    const { mx, versionGets } = setup();
    mockInvoke.mockImplementation(async () => null);
    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });

    await vi.waitFor(() => expect(versionGets.length).toBe(1));

    await crypto.getKeyBackupInfo();
    await crypto.getKeyBackupInfo();
    await crypto.getKeyBackupInfo();

    expect(versionGets).toHaveLength(1);
  });

  it('re-reads the version after a backup is deleted', async () => {
    const { mx, versionGets } = setup();
    mockInvoke.mockImplementation(async () => null);
    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });
    await vi.waitFor(() => expect(versionGets.length).toBe(1));

    await crypto.getKeyBackupInfo();
    expect(versionGets).toHaveLength(1);

    await crypto.deleteKeyBackupVersion('1');
    await crypto.getKeyBackupInfo();
    expect(versionGets).toHaveLength(2);
  });
});
