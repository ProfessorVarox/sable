import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({
  engineInvoke: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

const mockInvoke = vi.mocked(engineInvoke);

const identity = { userId: '@me:e.org', deviceId: 'D' };

const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('coalesced crypto work', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('collapses flushes that arrive while a drain is running into one extra drain', async () => {
    const gate = Promise.withResolvers<void>();
    let drains = 0;
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method !== 'outgoingRequests') return null;
      drains += 1;
      await gate.promise;
      return [];
    });

    const mx = {
      http: { authedRequest: vi.fn<() => Promise<string>>() },
    } as unknown as MatrixClient;
    const crypto = new EngineCrypto(mx, identity);
    for (let i = 0; i < 5; i += 1) crypto.onSyncCompleted({});

    await Promise.resolve();
    expect(drains).toBe(1);

    gate.resolve();
    await vi.waitFor(() => expect(drains).toBe(2));

    await settle();
    expect(drains).toBe(2);
  });

  it('shares one in-flight key backup check between concurrent callers', async () => {
    const gate = Promise.withResolvers<void>();
    let versionGets = 0;
    const authedRequest = vi.fn<(...args: never[]) => Promise<unknown>>(
      async (_method: unknown, url: unknown) => {
        if (url === '/room_keys/version') {
          versionGets += 1;
          await gate.promise;
        }
        return {};
      }
    );
    mockInvoke.mockImplementation(async () => null);

    const crypto = new EngineCrypto(
      { http: { authedRequest } } as unknown as MatrixClient,
      identity
    );
    const checks = Array.from({ length: 5 }, () => crypto.checkKeyBackupAndEnable());

    await Promise.resolve();
    gate.resolve();
    await Promise.all(checks);
    await settle();

    expect(versionGets).toBe(1);
  });

  it('drops an unparseable to-device event instead of failing the batch', async () => {
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method !== 'receiveSyncChanges') return null;
      return [
        { type: 2, rawEvent: 'not json' },
        { type: 2, rawEvent: JSON.stringify({ type: 'm.room_key', sender: '@a:e.org' }) },
      ];
    });

    const mx = {
      http: { authedRequest: vi.fn<() => Promise<string>>() },
    } as unknown as MatrixClient;
    const crypto = new EngineCrypto(mx, identity);

    const received = await crypto.preprocessToDeviceMessages([]);
    expect(received).toHaveLength(1);
    expect(received[0]?.message.type).toBe('m.room_key');
  });
});
