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

describe('room-key preparation', () => {
  afterEach(() => {
    vi.useRealTimers();
    mockInvoke.mockReset();
  });

  it('shares room keys during preparation instead of delaying the send', async () => {
    vi.useFakeTimers();
    let shareAcknowledged = false;
    const share = {
      id: 'share',
      type: 3,
      event_type: 'm.room.encrypted',
      txn_id: 'share',
      body: '{}',
    };
    const authedRequest = vi.fn<(...args: never[]) => Promise<string>>(async (_method, url) => {
      if (String(url).startsWith('/_matrix/client/v3/sendToDevice/')) {
        return new Promise((resolve) => setTimeout(() => resolve('{}'), 20_000));
      }
      return '{}';
    });
    mockInvoke.mockImplementation(async (_identity, method, args) => {
      if (method === 'queryKeysForUsers') return { id: 'query', type: 1, body: '{}' };
      if (method === 'shareRoomKey') return shareAcknowledged ? [] : [share];
      if (method === 'markRequestAsSent' && (args as { requestId: string }).requestId === 'share') {
        shareAcknowledged = true;
      }
      if (method === 'encryptRoomEvent') return '{}';
      if (method === 'identityKeys') return { ed25519: 'ed', curve25519: 'curve' };
      return null;
    });

    const crypto = new EngineCrypto({ http: { authedRequest } } as unknown as MatrixClient, {
      userId: '@me:e.org',
      deviceId: 'D',
    });
    crypto.prepareToEncrypt(room);
    await vi.runAllTimersAsync();

    const started = Date.now();
    const send = crypto.encryptEvent(event(), room).then(() => Date.now() - started);
    await vi.runAllTimersAsync();

    expect(await send).toBe(0);
    expect(
      authedRequest.mock.calls.filter(([, url]) => String(url).includes('/sendToDevice/'))
    ).toHaveLength(1);
    expect(mockInvoke.mock.calls.filter(([, method]) => method === 'shareRoomKey')).toHaveLength(2);
  });

  it('keeps a concurrent send behind room-key sharing and its acknowledgement', async () => {
    vi.useFakeTimers();
    const shareResponse = Promise.withResolvers<string>();
    const shareAcknowledged = Promise.withResolvers<void>();
    const authedRequest = vi.fn<(...args: never[]) => Promise<string>>(async (_method, url) => {
      if (String(url).startsWith('/_matrix/client/v3/sendToDevice/')) return shareResponse.promise;
      return '{}';
    });
    mockInvoke.mockImplementation(async (_identity, method, args) => {
      if (method === 'queryKeysForUsers') return { id: 'query', type: 1, body: '{}' };
      if (method === 'shareRoomKey')
        return [
          { id: 'share', type: 3, event_type: 'm.room.encrypted', txn_id: 'share', body: '{}' },
        ];
      if (method === 'markRequestAsSent' && (args as { requestId: string }).requestId === 'share')
        await shareAcknowledged.promise;
      if (method === 'encryptRoomEvent') return '{}';
      if (method === 'identityKeys') return { ed25519: 'ed', curve25519: 'curve' };
      return null;
    });

    const crypto = new EngineCrypto({ http: { authedRequest } } as unknown as MatrixClient, {
      userId: '@me:e.org',
      deviceId: 'D',
    });
    crypto.prepareToEncrypt(room);
    const send = crypto.encryptEvent(event(), room);
    try {
      await vi.waitFor(() =>
        expect(authedRequest).toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('/sendToDevice/'),
          expect.anything(),
          expect.anything(),
          expect.anything()
        )
      );
      expect(
        mockInvoke.mock.calls.filter(([, method]) => method === 'encryptRoomEvent')
      ).toHaveLength(0);
      shareResponse.resolve('{}');
      await vi.waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith(
          expect.anything(),
          'markRequestAsSent',
          expect.objectContaining({ requestId: 'share' })
        )
      );
      expect(
        mockInvoke.mock.calls.filter(([, method]) => method === 'encryptRoomEvent')
      ).toHaveLength(0);
      shareAcknowledged.resolve();
      await send;
    } finally {
      shareResponse.resolve('{}');
      shareAcknowledged.resolve();
      await send;
    }
  });
});
