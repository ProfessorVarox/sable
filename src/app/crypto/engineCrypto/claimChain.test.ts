import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({
  engineInvoke: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

const mockInvoke = vi.mocked(engineInvoke);

const room = (roomId: string) =>
  ({
    roomId,
    getEncryptionTargetMembers: async () => [{ userId: '@them:e.org' }],
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

const client = () =>
  ({
    http: { authedRequest: vi.fn<(...args: never[]) => Promise<string>>(async () => '{}') },
  }) as unknown as MatrixClient;

describe('key claim serialisation', () => {
  it('never claims keys for two rooms at the same time', async () => {
    const marks: string[] = [];
    let inFlight = 0;

    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'getMissingSessions') {
        inFlight += 1;
        marks.push(`enter${inFlight}`);
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        inFlight -= 1;
        marks.push('exit');
        return null;
      }
      if (method === 'encryptRoomEvent') return '{}';
      if (method === 'identityKeys') return { ed25519: 'e', curve25519: 'c' };
      return null;
    });

    const crypto = new EngineCrypto(client(), { userId: '@me:e.org', deviceId: 'D' });

    await Promise.all([
      crypto.encryptEvent(event(), room('!a:e.org')),
      crypto.encryptEvent(event(), room('!b:e.org')),
    ]);

    expect(marks).toEqual(['enter1', 'exit', 'enter1', 'exit']);
  });

  it('claims keys for every encryption target member', async () => {
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'encryptRoomEvent') return '{}';
      if (method === 'identityKeys') return { ed25519: 'e', curve25519: 'c' };
      return null;
    });

    const crypto = new EngineCrypto(client(), { userId: '@me:e.org', deviceId: 'D' });
    await crypto.encryptEvent(event(), room('!a:e.org'));

    const args = mockInvoke.mock.calls.find(([, method]) => method === 'getMissingSessions')?.[2];
    expect(args).toEqual({ users: ['@them:e.org'] });
  });
});
