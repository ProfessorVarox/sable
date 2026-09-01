import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyBackupSession } from 'matrix-js-sdk/lib/crypto-api/keybackup';
import type { MatrixClient } from '$types/matrix-sdk';
import { BACKOFF_TIME_MS, PerSessionBackupDownloader } from './perSessionBackupDownload';

const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

const rateLimited = (retryAfterMs: number) =>
  Object.assign(new Error('slow down'), {
    httpStatus: 429,
    data: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: retryAfterMs },
  });

describe('PerSessionBackupDownloader', () => {
  let clock = 0;
  let backupVersion: string | null = '7';

  beforeEach(() => {
    clock = 0;
    backupVersion = '7';
  });

  const make = (
    authedRequest: ReturnType<typeof vi.fn<(...args: never[]) => Promise<unknown>>>,
    importSession = vi.fn<(roomId: string, session: KeyBackupSession) => Promise<boolean>>(
      async () => true
    )
  ) => {
    const downloader = new PerSessionBackupDownloader({
      mx: { http: { authedRequest } } as unknown as MatrixClient,
      getBackupVersion: async () => backupVersion,
      importSession,
      now: () => clock,
    });
    return { downloader, importSession };
  };

  it('fetches the one missing session and imports it', async () => {
    const authedRequest = vi.fn<(...args: never[]) => Promise<unknown>>(async () => ({
      session_data: {},
    }));
    const { downloader, importSession } = make(authedRequest);

    downloader.request({ roomId: '!r:e.org', sessionId: 'S1' });
    await settle();

    expect(authedRequest).toHaveBeenCalledTimes(1);
    expect(authedRequest.mock.calls[0]?.[1]).toBe('/room_keys/keys/!r%3Ae.org/S1');
    expect(authedRequest.mock.calls[0]?.[2]).toEqual({ version: '7' });
    expect(importSession).toHaveBeenCalledTimes(1);
  });

  it('does not query the backup when no active version is known', async () => {
    backupVersion = null;
    const authedRequest = vi.fn<(...args: never[]) => Promise<unknown>>(async () => ({
      session_data: {},
    }));
    const { downloader, importSession } = make(authedRequest);

    downloader.request({ roomId: '!r:e.org', sessionId: 'S1' });
    await settle();

    expect(authedRequest).not.toHaveBeenCalled();
    expect(importSession).not.toHaveBeenCalled();
  });

  it('does not hammer the backup for a session it is already fetching', async () => {
    const authedRequest = vi.fn<(...args: never[]) => Promise<unknown>>(async () => ({
      session_data: {},
    }));
    const { downloader } = make(authedRequest);

    downloader.request({ roomId: '!r:e.org', sessionId: 'S1' });
    downloader.request({ roomId: '!r:e.org', sessionId: 'S1' });
    downloader.request({ roomId: '!r:e.org', sessionId: 'S2' });
    await settle();

    expect(authedRequest).toHaveBeenCalledTimes(2);
  });

  it('does not re-request a session the backup does not have until the backoff expires', async () => {
    const authedRequest = vi.fn<(...args: never[]) => Promise<unknown>>(async () => {
      throw Object.assign(new Error('nope'), { httpStatus: 404, data: {} });
    });
    const { downloader } = make(authedRequest);

    downloader.request({ roomId: '!r:e.org', sessionId: 'S1' });
    await settle();
    downloader.request({ roomId: '!r:e.org', sessionId: 'S1' });
    await settle();
    expect(authedRequest).toHaveBeenCalledTimes(1);

    clock += BACKOFF_TIME_MS + 1;
    downloader.request({ roomId: '!r:e.org', sessionId: 'S1' });
    await settle();
    expect(authedRequest).toHaveBeenCalledTimes(2);
  });

  it('stops fetching once told to stop', async () => {
    const authedRequest = vi.fn<(...args: never[]) => Promise<unknown>>(async () => ({
      session_data: {},
    }));
    const { downloader } = make(authedRequest);

    downloader.stop();
    downloader.request({ roomId: '!r:e.org', sessionId: 'S1' });
    await settle();

    expect(authedRequest).not.toHaveBeenCalled();
  });

  it('re-queues a rate-limited session instead of dropping it', async () => {
    const authedRequest = vi
      .fn<(...args: never[]) => Promise<unknown>>()
      .mockRejectedValueOnce(rateLimited(0))
      .mockResolvedValue({ session_data: {} });
    const { downloader, importSession } = make(authedRequest);

    downloader.request({ roomId: '!r:e.org', sessionId: 'S1' });
    await settle();

    expect(authedRequest.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(importSession).toHaveBeenCalled();
  });
});
