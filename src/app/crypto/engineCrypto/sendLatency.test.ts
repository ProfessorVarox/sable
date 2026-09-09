import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({
  engineInvoke: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

const mockInvoke = vi.mocked(engineInvoke);

const room = {
  roomId: '!room:e.org',
  getEncryptionTargetMembers: async () => [{ userId: '@a:e.org' }],
  getHistoryVisibility: () => 'shared',
  getBlacklistUnverifiedDevices: () => false,
  currentState: { getStateEvents: () => null },
} as unknown as Room;

const event = () =>
  ({
    getType: () => 'm.room.message',
    getContent: () => ({ body: 'hello' }),
    makeEncrypted: vi.fn<() => void>(),
  }) as unknown as MatrixEvent;

describe('first encrypted send latency', () => {
  afterEach(() => mockInvoke.mockReset());

  it.each([false, true])(
    'does not wait for an unrelated outgoing drain (%s preparation)',
    async (prepareFirst) => {
      const signatureUpload = Promise.withResolvers<string>();
      let signatureAcknowledged = false;
      const authedRequest = vi.fn<(...args: never[]) => Promise<string>>(async (_method, url) => {
        if (url === '/_matrix/client/v3/keys/signatures/upload') return signatureUpload.promise;
        return '{}';
      });

      mockInvoke.mockImplementation(async (_identity, method, args) => {
        if (method === 'outgoingRequests')
          return signatureAcknowledged ? [] : [{ id: 'signature', type: 4, body: '{}' }];
        if (method === 'markRequestAsSent') {
          if ((args as { requestId?: string } | undefined)?.requestId === 'signature') {
            signatureAcknowledged = true;
          }
          return null;
        }
        if (method === 'queryKeysForUsers') return { id: 'query', type: 1, body: '{}' };
        if (method === 'getMissingSessions') return { id: 'claim', type: 2, body: '{}' };
        if (method === 'shareRoomKey') {
          return [
            {
              id: 'share',
              type: 3,
              event_type: 'm.room.encrypted',
              txn_id: 'share',
              body: '{}',
            },
          ];
        }
        if (method === 'encryptRoomEvent') return '{}';
        if (method === 'identityKeys') return { ed25519: 'ed', curve25519: 'curve' };
        return null;
      });

      const crypto = new EngineCrypto({ http: { authedRequest } } as unknown as MatrixClient, {
        userId: '@me:e.org',
        deviceId: 'D',
      });
      crypto.onSyncCompleted({});
      await vi.waitFor(() =>
        expect(authedRequest).toHaveBeenCalledWith(
          expect.anything(),
          '/_matrix/client/v3/keys/signatures/upload',
          expect.anything(),
          expect.anything(),
          expect.anything()
        )
      );

      let send: Promise<void> | undefined;
      try {
        if (prepareFirst) crypto.prepareToEncrypt(room);
        const encrypted = event();
        send = crypto.encryptEvent(encrypted, room);
        await vi.waitFor(() => expect(encrypted.makeEncrypted).toHaveBeenCalledOnce(), {
          timeout: 500,
        });
        await send;

        expect(
          mockInvoke.mock.calls.filter(([, method]) => method === 'queryKeysForUsers')
        ).toHaveLength(1);

        const methods = mockInvoke.mock.calls.map(([, method]) => method);
        const marked = (requestId: string) =>
          mockInvoke.mock.calls.findIndex(
            ([, method, args]) =>
              method === 'markRequestAsSent' &&
              (args as { requestId: string }).requestId === requestId
          );
        expect(marked('query')).toBeGreaterThanOrEqual(0);
        expect(marked('query')).toBeLessThan(methods.indexOf('getMissingSessions'));
        expect(marked('claim')).toBeGreaterThanOrEqual(0);
        expect(marked('claim')).toBeLessThan(methods.indexOf('shareRoomKey'));
        expect(marked('share')).toBeGreaterThanOrEqual(0);
        expect(marked('share')).toBeLessThan(methods.indexOf('encryptRoomEvent'));
      } finally {
        signatureUpload.resolve('{}');
        await send;
      }
    }
  );

  it('retries the initial query when preparation could not send it', async () => {
    let failFirstQuery = true;
    const authedRequest = vi.fn<(...args: never[]) => Promise<string>>(async (_method, url) => {
      if (url === '/_matrix/client/v3/keys/query' && failFirstQuery) {
        failFirstQuery = false;
        throw new Error('query failed');
      }
      return '{}';
    });
    mockInvoke.mockImplementation(async (_identity, method) => {
      if (method === 'queryKeysForUsers') return { id: 'query', type: 1, body: '{}' };
      if (method === 'encryptRoomEvent') return '{}';
      if (method === 'identityKeys') return { ed25519: 'ed', curve25519: 'curve' };
      return null;
    });
    const crypto = new EngineCrypto({ http: { authedRequest } } as unknown as MatrixClient, {
      userId: '@me:e.org',
      deviceId: 'D',
    });

    crypto.prepareToEncrypt(room);
    await vi.waitFor(() =>
      expect(authedRequest).toHaveBeenCalledWith(
        expect.anything(),
        '/_matrix/client/v3/keys/query',
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
    );
    await vi.waitFor(() =>
      expect(
        mockInvoke.mock.calls.filter(([, method]) => method === 'encryptRoomEvent')
      ).toHaveLength(0)
    );

    const encrypted = event();
    await crypto.encryptEvent(encrypted, room);

    expect(encrypted.makeEncrypted).toHaveBeenCalledOnce();
    expect(
      authedRequest.mock.calls.filter(([, url]) => url === '/_matrix/client/v3/keys/query')
    ).toHaveLength(2);
  });
});
