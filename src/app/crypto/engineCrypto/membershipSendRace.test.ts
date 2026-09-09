import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventType, KnownMembership } from '$types/matrix-sdk';
import type { MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({
  engineInvoke: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

const mockInvoke = vi.mocked(engineInvoke);

const deferred = <T>() => Promise.withResolvers<T>();

const memberEvent = () =>
  ({
    getType: () => EventType.RoomMember,
    getStateKey: () => '@departed:e.org',
    getContent: () => ({ membership: KnownMembership.Leave }),
    getRoomId: () => '!room:e.org',
  }) as unknown as MatrixEvent;

const encryptedEvent = () =>
  ({
    getType: () => 'm.room.message',
    getContent: () => ({ body: 'hello' }),
    makeEncrypted: vi.fn<(...args: never[]) => void>(),
  }) as unknown as MatrixEvent;

const setup = () => {
  let members = [{ userId: '@departed:e.org' }];
  const room = {
    roomId: '!room:e.org',
    getEncryptionTargetMembers: () => Promise.resolve(members),
    getHistoryVisibility: () => 'shared',
    getBlacklistUnverifiedDevices: () => false,
    currentState: { getStateEvents: () => null },
  } as unknown as Room;
  const authedRequest = vi.fn<(...args: never[]) => Promise<string>>(async () => '{}');
  const crypto = new EngineCrypto({ http: { authedRequest } } as unknown as MatrixClient, {
    userId: '@me:e.org',
    deviceId: 'D',
  });
  return {
    crypto,
    room,
    authedRequest,
    replaceMembers: (next: string) => {
      members = [{ userId: next }];
    },
  };
};

describe('membership changes racing room sends', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('reprepares with the current recipients after a leave during room-key delivery', async () => {
    const shareDelivery = deferred<string>();
    const invalidated = deferred<void>();
    const { crypto, room, authedRequest, replaceMembers } = setup();
    let shares = 0;
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'shareRoomKey') {
        shares += 1;
        return [
          {
            id: `share-${shares}`,
            type: 3,
            event_type: 'm.room.encrypted',
            txn_id: 't',
            body: '{}',
          },
        ];
      }
      if (method === 'invalidateGroupSession') return invalidated.promise;
      if (method === 'encryptRoomEvent') return JSON.stringify({ session_id: `session-${shares}` });
      if (method === 'identityKeys') return { ed25519: 'ed', curve25519: 'curve' };
      return null;
    });
    authedRequest.mockImplementation(async (_method, url) =>
      String(url).includes('/sendToDevice/') ? shareDelivery.promise : '{}'
    );

    const event = encryptedEvent();
    const send = crypto.encryptEvent(event, room);
    await vi.waitFor(() =>
      expect(
        authedRequest.mock.calls.some(([, url]) => String(url).includes('/sendToDevice/'))
      ).toBe(true)
    );
    replaceMembers('@joined:e.org');
    crypto.onRoomStateEvent(memberEvent());
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.anything(),
        'invalidateGroupSession',
        expect.anything()
      )
    );
    shareDelivery.resolve('{}');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(event.makeEncrypted).not.toHaveBeenCalled();
    expect(mockInvoke.mock.calls.filter(([, method]) => method === 'shareRoomKey')).toHaveLength(1);
    invalidated.resolve();
    await send;

    const users = mockInvoke.mock.calls
      .filter(([, method]) => method === 'shareRoomKey')
      .map(([, , args]) => (args as { users: string[] }).users);
    expect(users).toEqual([['@departed:e.org'], ['@joined:e.org']]);
    expect(event.makeEncrypted).toHaveBeenCalledTimes(1);
  });

  it('discards ciphertext produced while invalidation is pending', async () => {
    const oldCiphertext = deferred<string>();
    const invalidated = deferred<void>();
    const { crypto, room } = setup();
    let encryptions = 0;
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'invalidateGroupSession') return invalidated.promise;
      if (method === 'encryptRoomEvent') {
        encryptions += 1;
        return encryptions === 1 ? oldCiphertext.promise : JSON.stringify({ session_id: 'new' });
      }
      if (method === 'identityKeys') return { ed25519: 'ed', curve25519: 'curve' };
      return null;
    });

    const event = encryptedEvent();
    const send = crypto.encryptEvent(event, room);
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.anything(),
        'encryptRoomEvent',
        expect.anything()
      )
    );
    crypto.onRoomStateEvent(memberEvent());
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.anything(),
        'invalidateGroupSession',
        expect.anything()
      )
    );
    oldCiphertext.resolve(JSON.stringify({ session_id: 'old' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(event.makeEncrypted).not.toHaveBeenCalled();
    expect(encryptions).toBe(1);
    invalidated.resolve();
    await send;

    expect(encryptions).toBe(2);
    expect(event.makeEncrypted).toHaveBeenCalledTimes(1);
    expect(event.makeEncrypted).toHaveBeenCalledWith(
      'm.room.encrypted',
      { session_id: 'new' },
      'curve',
      'ed'
    );
  });

  it('discards ciphertext when membership changes while fetching identity keys', async () => {
    const oldKeys = deferred<{ ed25519: string; curve25519: string }>();
    const invalidated = deferred<void>();
    const { crypto, room } = setup();
    let encryptions = 0;
    let keyRequests = 0;
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'invalidateGroupSession') return invalidated.promise;
      if (method === 'encryptRoomEvent') {
        encryptions += 1;
        return JSON.stringify({ session_id: encryptions === 1 ? 'old' : 'new' });
      }
      if (method === 'identityKeys') {
        keyRequests += 1;
        return keyRequests === 1 ? oldKeys.promise : { ed25519: 'ed', curve25519: 'curve' };
      }
      return null;
    });

    const event = encryptedEvent();
    const send = crypto.encryptEvent(event, room);
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(expect.anything(), 'identityKeys', expect.anything())
    );
    crypto.onRoomStateEvent(memberEvent());
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.anything(),
        'invalidateGroupSession',
        expect.anything()
      )
    );
    oldKeys.resolve({ ed25519: 'old-ed', curve25519: 'old-curve' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(event.makeEncrypted).not.toHaveBeenCalled();
    expect(encryptions).toBe(1);
    invalidated.resolve();
    await send;

    expect(event.makeEncrypted).toHaveBeenCalledWith(
      'm.room.encrypted',
      { session_id: 'new' },
      'curve',
      'ed'
    );
    expect(event.makeEncrypted).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed invalidation', async () => {
    const { crypto, room } = setup();
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'invalidateGroupSession') throw new Error('invalidation failed');
      return null;
    });

    await expect(crypto.forceDiscardSession('!room:e.org')).rejects.toThrow('invalidation failed');
    const event = encryptedEvent();
    await expect(crypto.encryptEvent(event, room)).rejects.toThrow('invalidation failed');
    expect(event.makeEncrypted).not.toHaveBeenCalled();
  });

  it('serializes consecutive invalidations and waits for the latest one before sending', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const { crypto, room } = setup();
    let invalidations = 0;
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'invalidateGroupSession') {
        invalidations += 1;
        return invalidations === 1 ? first.promise : second.promise;
      }
      if (method === 'encryptRoomEvent') return '{}';
      if (method === 'identityKeys') return { ed25519: 'ed', curve25519: 'curve' };
      return null;
    });

    const firstDiscard = crypto.forceDiscardSession(room.roomId);
    const secondDiscard = crypto.forceDiscardSession(room.roomId);
    await vi.waitFor(() => expect(invalidations).toBe(1));
    first.resolve();
    await vi.waitFor(() => expect(invalidations).toBe(2));

    const event = encryptedEvent();
    const send = crypto.encryptEvent(event, room);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(
      mockInvoke.mock.calls.filter(([, method]) => method === 'encryptRoomEvent')
    ).toHaveLength(0);
    second.resolve();
    await Promise.all([firstDiscard, secondDiscard, send]);
    expect(event.makeEncrypted).toHaveBeenCalledTimes(1);
  });
});
