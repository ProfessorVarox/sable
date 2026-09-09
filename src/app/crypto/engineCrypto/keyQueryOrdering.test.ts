import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import { engineInvoke } from '../olmMachine/engineInvoke';
import { EngineCrypto } from './EngineCrypto';

vi.mock('../olmMachine/engineInvoke', () => ({
  engineInvoke: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

const mockInvoke = vi.mocked(engineInvoke);
const identity = { userId: '@me:e.org', deviceId: 'D' };

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

describe('keys/query ordering', () => {
  afterEach(() => mockInvoke.mockReset());

  it('waits for a background query HTTP response and acknowledgement before a first-room query', async () => {
    const http = Promise.withResolvers<string>();
    const acknowledgement = Promise.withResolvers<void>();
    let backgroundAcknowledged = false;
    let queries = 0;
    const authedRequest = vi.fn<(...args: never[]) => Promise<string>>(async (_method, url) => {
      if (url !== '/_matrix/client/v3/keys/query') return '{}';
      queries += 1;
      if (queries === 1) return http.promise;
      return '{}';
    });
    mockInvoke.mockImplementation(async (_identity, method, args) => {
      if (method === 'outgoingRequests')
        return backgroundAcknowledged ? [] : [{ id: 'background', type: 1, body: '{}' }];
      if (method === 'markRequestAsSent') {
        if ((args as { requestId: string }).requestId === 'background') {
          await acknowledgement.promise;
          backgroundAcknowledged = true;
        }
        return null;
      }
      if (method === 'queryKeysForUsers') return { id: 'room', type: 1, body: '{}' };
      if (method === 'getMissingSessions') return null;
      if (method === 'shareRoomKey') return [];
      if (method === 'encryptRoomEvent') return '{}';
      if (method === 'identityKeys') return { ed25519: 'ed', curve25519: 'curve' };
      return null;
    });
    const crypto = new EngineCrypto(
      { http: { authedRequest } } as unknown as MatrixClient,
      identity
    );

    crypto.onSyncCompleted({});
    const keyQueries = () =>
      authedRequest.mock.calls.filter(([, url]) => url === '/_matrix/client/v3/keys/query');
    await vi.waitFor(() => expect(keyQueries()).toHaveLength(1));

    const send = crypto.encryptEvent(event(), room);
    try {
      await vi.waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(
          expect.anything(),
          'queryKeysForUsers',
          expect.anything()
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(keyQueries()).toHaveLength(1);

      http.resolve('{}');
      await vi.waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(
          expect.anything(),
          'markRequestAsSent',
          expect.anything()
        )
      );
      expect(keyQueries()).toHaveLength(1);

      acknowledgement.resolve();
      await vi.waitFor(() => expect(keyQueries()).toHaveLength(2));
    } finally {
      http.resolve('{}');
      acknowledgement.resolve();
      await send;
    }
  });
});
