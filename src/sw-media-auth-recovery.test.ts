/* oxlint-disable vitest/require-mock-type-parameters */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { swTestHooks as swTestHooksHelper } from './sw';

vi.mock('workbox-precaching', () => ({
  cleanupOutdatedCaches: vi.fn(),
  precacheAndRoute: vi.fn(),
}));

type SwTestHooks = typeof swTestHooksHelper;

describe('service worker media auth recovery', () => {
  let swTestHooks: SwTestHooks;
  let clients: Map<string, Client>;
  let addEventListener: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    clients = new Map();
    addEventListener = vi.fn();
    vi.stubGlobal('self', {
      __WB_MANIFEST: [],
      addEventListener,
      caches: {
        open: vi.fn(async () => ({
          delete: vi.fn(async () => true),
          match: vi.fn(async () => undefined),
          put: vi.fn(async () => undefined),
        })),
      },
      clients: {
        claim: vi.fn(),
        get: vi.fn(async (id: string) => clients.get(id)),
        matchAll: vi.fn(async () => Array.from(clients.values())),
      },
      registration: {},
    });
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>());
    swTestHooks = (await import('./sw')).swTestHooks;
  });

  it('does not intercept media requests that already carry authorization', () => {
    const fetchHandler = addEventListener.mock.calls.find(([type]) => type === 'fetch')?.[1] as
      | ((event: FetchEvent) => void)
      | undefined;
    const respondWith = vi.fn();
    const request = new Request(
      'https://matrix.example.org/_matrix/client/v1/media/download/example.org/media-id',
      { headers: { Authorization: 'Bearer direct-token' } }
    );

    fetchHandler?.({ request, respondWith, clientId: 'client-a' } as unknown as FetchEvent);

    expect(fetchHandler).toBeTypeOf('function');
    expect(respondWith).not.toHaveBeenCalled();
  });

  it('shares recovery and preserves each Range header on retry', async () => {
    const client = {
      id: 'client-a',
      postMessage: vi.fn(),
    } as unknown as Client;
    clients.set(client.id, client);

    const initialSession = { accessToken: 'old-token', baseUrl: 'https://matrix.example.org' };
    const ranges: Array<{ authorization: string | null; range: string | null }> = [];
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      ranges.push({ authorization: headers.get('authorization'), range: headers.get('range') });
      const isOldToken = headers.get('authorization') === 'Bearer old-token';
      return new Response(isOldToken ? JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN' }) : '', {
        status: isOldToken ? 401 : 206,
      });
    });

    const first = new Request(
      'https://matrix.example.org/_matrix/client/v1/media/download/example.org/media-id',
      { headers: { Range: 'bytes=0-99' } }
    );
    const second = new Request(first.url, { headers: { Range: 'bytes=100-199' } });
    const firstRecovery = swTestHooks.respondWithMediaAuthRecovery(
      first,
      initialSession,
      'follow',
      client.id
    );
    const secondRecovery = swTestHooks.respondWithMediaAuthRecovery(
      second,
      initialSession,
      'follow',
      client.id
    );

    await vi.waitFor(() => expect(client.postMessage).toHaveBeenCalledTimes(1));
    swTestHooks.setSession(client.id, 'new-token', initialSession.baseUrl);

    await expect(firstRecovery).resolves.toHaveProperty('status', 206);
    await expect(secondRecovery).resolves.toHaveProperty('status', 206);
    expect(ranges).toEqual([
      { authorization: 'Bearer old-token', range: 'bytes=0-99' },
      { authorization: 'Bearer old-token', range: 'bytes=100-199' },
      { authorization: 'Bearer new-token', range: 'bytes=0-99' },
      { authorization: 'Bearer new-token', range: 'bytes=100-199' },
    ]);
  });

  it('streams a ranged response without waiting for the whole body', async () => {
    const session = { accessToken: 'token', baseUrl: 'https://matrix.example.org' };
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(body, { status: 206, headers: { 'Content-Range': 'bytes 0-1/2' } })
    );

    const request = new Request(
      'https://matrix.example.org/_matrix/client/v1/media/download/example.org/media-id',
      { headers: { Range: 'bytes=0-' } }
    );

    // Buffering the body would hang here: the stream is still open.
    const response = await swTestHooks.respondWithMediaAuthRecovery(request, session, 'follow');
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 0-1/2');

    bodyController?.enqueue(new Uint8Array([1, 2]));
    bodyController?.close();
    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 2);
  });

  it('posts a new session request after a previous request times out', async () => {
    const client = {
      id: 'client-timeout',
      postMessage: vi.fn(),
    } as unknown as Client;
    clients.set(client.id, client);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(swTestHooks.requestSessionWithTimeout(client.id, 1)).resolves.toBeUndefined();
    const nextRequest = swTestHooks.requestSessionWithTimeout(client.id, 1000);
    await vi.waitFor(() => expect(client.postMessage).toHaveBeenCalledTimes(2));
    swTestHooks.setSession(client.id, 'new-token', 'https://matrix.example.org');
    await expect(nextRequest).resolves.toMatchObject({ accessToken: 'new-token' });
  });

  it('does not retry when the refreshed session has the same access token', async () => {
    const client = {
      id: 'client-same-token',
      postMessage: vi.fn(),
    } as unknown as Client;
    clients.set(client.id, client);
    const session = { accessToken: 'same-token', baseUrl: 'https://matrix.example.org' };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN' }), { status: 401 })
    );

    const request = new Request(
      'https://matrix.example.org/_matrix/client/v1/media/download/example.org/media-id'
    );
    const recovery = swTestHooks.respondWithMediaAuthRecovery(
      request,
      session,
      'follow',
      client.id
    );

    await vi.waitFor(() => expect(client.postMessage).toHaveBeenCalledTimes(1));
    swTestHooks.setSession(client.id, 'same-token', session.baseUrl);

    await expect(recovery).resolves.toHaveProperty('status', 401);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
