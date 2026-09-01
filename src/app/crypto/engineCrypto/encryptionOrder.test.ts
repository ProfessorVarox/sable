import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({
  engineInvoke: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

const mockInvoke = vi.mocked(engineInvoke);

const room = (roomId: string, onMembers?: () => void) =>
  ({
    roomId,
    getEncryptionTargetMembers: async () => {
      onMembers?.();
      return [{ userId: '@me:e.org' }];
    },
    getHistoryVisibility: () => 'shared',
    getBlacklistUnverifiedDevices: () => false,
    currentState: { getStateEvents: () => null },
  }) as unknown as Room;

const event = () =>
  ({
    getType: () => 'm.room.message',
    getContent: () => ({}),
    makeEncrypted: vi.fn<() => void>(),
    getTxnId: () => 't',
  }) as unknown as MatrixEvent;

describe('encryptEvent ordering', () => {
  it('does not look up members for the next event until the previous one is encrypted', async () => {
    let lookups = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'encryptRoomEvent') {
        await held;
        return '{}';
      }
      if (method === 'identityKeys') return { ed25519: 'e', curve25519: 'c' };
      return null;
    });

    const mx = { http: { authedRequest: vi.fn<() => void>() } } as unknown as MatrixClient;
    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });
    const target = room('!r:e.org', () => {
      lookups += 1;
    });

    const both = Promise.all([
      crypto.encryptEvent(event(), target),
      crypto.encryptEvent(event(), target),
    ]);

    await Promise.resolve();
    await Promise.resolve();
    expect(lookups).toBe(1);

    release?.();
    await both;
    expect(lookups).toBe(2);
  });

  it('never runs two encryptions for a room at the same time', async () => {
    const marks: string[] = [];
    let inFlight = 0;

    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'encryptRoomEvent') {
        inFlight += 1;
        marks.push(`enter${inFlight}`);
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        inFlight -= 1;
        marks.push('exit');
        return '{}';
      }
      if (method === 'identityKeys') return { ed25519: 'e', curve25519: 'c' };
      return null;
    });

    const mx = { http: { authedRequest: vi.fn<() => void>() } } as unknown as MatrixClient;
    const crypto = new EngineCrypto(mx, { userId: '@me:e.org', deviceId: 'D' });

    await Promise.all([
      crypto.encryptEvent(event(), room('!r:e.org')),
      crypto.encryptEvent(event(), room('!r:e.org')),
    ]);

    expect(marks).toEqual(['enter1', 'exit', 'enter1', 'exit']);
  });
});
