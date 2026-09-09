import { afterEach, describe, expect, it, vi } from 'vitest';
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
    getEncryptionTargetMembers: async () => [{ userId: `@${roomId.slice(1, 2)}:e.org` }],
    getHistoryVisibility: () => 'shared',
    getBlacklistUnverifiedDevices: () => false,
    currentState: { getStateEvents: () => null },
  }) as unknown as Room;

const event = (body: string) =>
  ({
    getType: () => 'm.room.message',
    getContent: () => ({ body }),
    makeEncrypted: vi.fn<() => void>(),
  }) as unknown as MatrixEvent;

const cryptoWith = (authedRequest: ReturnType<typeof vi.fn>) =>
  new EngineCrypto({ http: { authedRequest } } as unknown as MatrixClient, {
    userId: '@me:e.org',
    deviceId: 'D',
  });

describe('encrypted send concurrency', () => {
  afterEach(() => mockInvoke.mockReset());

  it('holds same-room sends behind preparation response and acknowledgement', async () => {
    const queryResponse = Promise.withResolvers<string>();
    const queryAcknowledged = Promise.withResolvers<void>();
    const authedRequest = vi.fn<(...args: never[]) => Promise<string>>(async (_method, url) => {
      if (url === '/_matrix/client/v3/keys/query') return queryResponse.promise;
      return '{}';
    });
    mockInvoke.mockImplementation(async (_identity, method, args) => {
      if (method === 'queryKeysForUsers') return { id: 'query', type: 1, body: '{}' };
      if (method === 'markRequestAsSent' && (args as { requestId: string }).requestId === 'query') {
        await queryAcknowledged.promise;
      }
      if (method === 'encryptRoomEvent') return '{}';
      if (method === 'identityKeys') return { ed25519: 'ed', curve25519: 'curve' };
      return null;
    });

    const crypto = cryptoWith(authedRequest);
    const target = room('!room:e.org');
    crypto.prepareToEncrypt(target);
    const sends = [
      crypto.encryptEvent(event('first'), target),
      crypto.encryptEvent(event('second'), target),
    ];

    try {
      await vi.waitFor(() => expect(authedRequest).toHaveBeenCalledOnce());
      expect(
        mockInvoke.mock.calls.filter(([, method]) => method === 'getMissingSessions')
      ).toHaveLength(0);

      queryResponse.resolve('{}');
      await vi.waitFor(() =>
        expect(mockInvoke.mock.calls).toContainEqual([
          expect.anything(),
          'markRequestAsSent',
          expect.objectContaining({ requestId: 'query' }),
        ])
      );
      expect(
        mockInvoke.mock.calls.filter(([, method]) => method === 'getMissingSessions')
      ).toHaveLength(0);

      queryAcknowledged.resolve();
      await Promise.all(sends);

      expect(
        mockInvoke.mock.calls.filter(([, method]) => method === 'queryKeysForUsers')
      ).toHaveLength(1);
      expect(
        mockInvoke.mock.calls
          .filter(([, method]) => method === 'encryptRoomEvent')
          .map(([, , args]) => JSON.parse((args as { content: string }).content).body)
      ).toEqual(['first', 'second']);
    } finally {
      queryResponse.resolve('{}');
      queryAcknowledged.resolve();
      await Promise.allSettled(sends);
    }
  });

  it('keeps claims for separate rooms serialized until their response is acknowledged', async () => {
    const firstClaimResponse = Promise.withResolvers<string>();
    const firstClaimAcknowledged = Promise.withResolvers<void>();
    let claimsSent = 0;
    let heldClaimId: string | undefined;
    let queries = 0;
    const authedRequest = vi.fn<(...args: never[]) => Promise<string>>(async (_method, url) => {
      if (url === '/_matrix/client/v3/keys/claim' && claimsSent++ === 0) {
        return firstClaimResponse.promise;
      }
      return '{}';
    });
    mockInvoke.mockImplementation(async (_identity, method, args) => {
      if (method === 'queryKeysForUsers') return { id: `query-${queries++}`, type: 1, body: '{}' };
      if (method === 'getMissingSessions') {
        const user = (args as { users: string[] }).users[0];
        return { id: `claim-${user}`, type: 2, body: '{}' };
      }
      if (method === 'markRequestAsSent') {
        const requestId = (args as { requestId: string }).requestId;
        if (requestId.startsWith('claim-') && !heldClaimId) {
          heldClaimId = requestId;
          await firstClaimAcknowledged.promise;
        }
      }
      if (method === 'encryptRoomEvent') return '{}';
      if (method === 'identityKeys') return { ed25519: 'ed', curve25519: 'curve' };
      return null;
    });

    const crypto = cryptoWith(authedRequest);
    const sends = [
      crypto.encryptEvent(event('a'), room('!a:e.org')),
      crypto.encryptEvent(event('b'), room('!b:e.org')),
    ];

    try {
      await vi.waitFor(() => expect(claimsSent).toBe(1));
      expect(
        mockInvoke.mock.calls.filter(([, method]) => method === 'getMissingSessions')
      ).toHaveLength(1);

      firstClaimResponse.resolve('{}');
      await vi.waitFor(() => expect(heldClaimId).toBeDefined());
      expect(
        mockInvoke.mock.calls.filter(([, method]) => method === 'getMissingSessions')
      ).toHaveLength(1);

      firstClaimAcknowledged.resolve();
      await Promise.all(sends);
      expect(
        mockInvoke.mock.calls.filter(([, method]) => method === 'getMissingSessions')
      ).toHaveLength(2);
    } finally {
      firstClaimResponse.resolve('{}');
      firstClaimAcknowledged.resolve();
      await Promise.allSettled(sends);
    }
  });

  it('lets a queued send retry after preparation query failure', async () => {
    const failedQuery = Promise.withResolvers<string>();
    let queries = 0;
    const authedRequest = vi.fn<(...args: never[]) => Promise<string>>(async (_method, url) => {
      if (url === '/_matrix/client/v3/keys/query' && queries++ === 0) return failedQuery.promise;
      return '{}';
    });
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'queryKeysForUsers') return { id: 'query', type: 1, body: '{}' };
      if (method === 'encryptRoomEvent') return '{}';
      if (method === 'identityKeys') return { ed25519: 'ed', curve25519: 'curve' };
      return null;
    });

    const crypto = cryptoWith(authedRequest);
    const target = room('!room:e.org');
    crypto.prepareToEncrypt(target);
    let send: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(queries).toBe(1));
      send = crypto.encryptEvent(event('after failure'), target);
      failedQuery.reject(new Error('query failed'));

      await expect(send).resolves.toBeUndefined();
      expect(queries).toBe(2);
    } finally {
      failedQuery.reject(new Error('query failed'));
      await send?.catch(() => undefined);
    }
  });
});
