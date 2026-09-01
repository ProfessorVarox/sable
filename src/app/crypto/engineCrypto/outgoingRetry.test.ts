import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionError, MatrixError, Method } from 'matrix-js-sdk/lib/http-api';
import { sleep } from 'matrix-js-sdk/lib/utils';
import type * as MatrixUtilsNs from 'matrix-js-sdk/lib/utils';

type MatrixUtils = typeof MatrixUtilsNs;
import type { MatrixClient } from '$types/matrix-sdk';
import { RequestType, sendOutgoingRequest } from './outgoing';

vi.mock('matrix-js-sdk/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<MatrixUtils>()),
  sleep: vi.fn<(ms: number) => Promise<void>>(async () => undefined),
}));

const rateLimited = (retryAfterMs = 10) =>
  new MatrixError(
    { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: retryAfterMs },
    429
  );

const clientWith = (authedRequest: unknown) =>
  ({ http: { authedRequest } }) as unknown as MatrixClient;

const request = { id: 'r1', type: RequestType.KeysClaim, body: '{}' };

describe('sendOutgoingRequest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries a rate-limited request instead of failing the caller', async () => {
    const authedRequest = vi
      .fn<(...args: never[]) => Promise<string>>()
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce('{}');
    const mx = { http: { authedRequest } } as unknown as MatrixClient;

    await expect(sendOutgoingRequest(mx, request)).resolves.toBe('{}');
    expect(authedRequest).toHaveBeenCalledTimes(2);
    expect(authedRequest.mock.calls[0]?.[0]).toBe(Method.Post);
  });

  it('waits as long as the server asks after a rate limit', async () => {
    const authedRequest = vi
      .fn<(...args: never[]) => Promise<string>>()
      .mockRejectedValueOnce(rateLimited(5000))
      .mockResolvedValueOnce('{}');

    await sendOutgoingRequest(clientWith(authedRequest), request);

    expect(vi.mocked(sleep)).toHaveBeenCalledWith(5000);
  });

  it('gives up after five attempts on a persistent server error', async () => {
    const authedRequest = vi
      .fn<(...args: never[]) => Promise<string>>()
      .mockRejectedValue(new MatrixError({ errcode: 'M_UNKNOWN', error: 'boom' }, 500));

    await expect(sendOutgoingRequest(clientWith(authedRequest), request)).rejects.toThrow('boom');
    expect(authedRequest).toHaveBeenCalledTimes(5);
  });

  it('does not retry a request the server says is too large', async () => {
    const authedRequest = vi
      .fn<(...args: never[]) => Promise<string>>()
      .mockRejectedValue(new MatrixError({ errcode: 'M_TOO_LARGE', error: 'too big' }, 502));

    await expect(sendOutgoingRequest(clientWith(authedRequest), request)).rejects.toThrow(
      'too big'
    );
    expect(authedRequest).toHaveBeenCalledTimes(1);
  });

  it('does not retry a request we aborted ourselves', async () => {
    const authedRequest = vi
      .fn<(...args: never[]) => Promise<string>>()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(sendOutgoingRequest(clientWith(authedRequest), request)).rejects.toThrow(
      'aborted'
    );
    expect(authedRequest).toHaveBeenCalledTimes(1);
  });

  it('retries after a connection error', async () => {
    const authedRequest = vi
      .fn<(...args: never[]) => Promise<string>>()
      .mockRejectedValueOnce(new ConnectionError('Failed to fetch'))
      .mockResolvedValueOnce('{}');

    await expect(sendOutgoingRequest(clientWith(authedRequest), request)).resolves.toBe('{}');
    expect(authedRequest).toHaveBeenCalledTimes(2);
  });

  it('rethrows an error that is not worth retrying', async () => {
    const authedRequest = vi
      .fn<(...args: never[]) => Promise<string>>()
      .mockRejectedValue(Object.assign(new Error('nope'), { httpStatus: 400, data: {} }));
    const mx = { http: { authedRequest } } as unknown as MatrixClient;

    await expect(sendOutgoingRequest(mx, request)).rejects.toThrow('nope');
    expect(authedRequest).toHaveBeenCalledTimes(1);
  });
});
