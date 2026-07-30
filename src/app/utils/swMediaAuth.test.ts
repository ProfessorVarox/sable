import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  hasServiceWorker: vi.fn<() => boolean>(),
}));

vi.mock('$utils/platform', () => platform);

function stubServiceWorker(controller: unknown): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller,
      addEventListener: vi.fn<(...args: unknown[]) => void>(),
      removeEventListener: vi.fn<(...args: unknown[]) => void>(),
    },
  });
}

describe('swMediaAuth', () => {
  beforeEach(() => {
    vi.resetModules();
    platform.hasServiceWorker.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves false without a service worker runtime', async () => {
    platform.hasServiceWorker.mockReturnValue(false);
    const mod = await import('./swMediaAuth');

    await expect(mod.probeSWMediaAuthSupport()).resolves.toBe(false);
    expect(mod.getCachedSWMediaAuthSupport()).toBe(false);
  });

  it('resolves false when no service worker controls the page', async () => {
    platform.hasServiceWorker.mockReturnValue(true);
    stubServiceWorker(null);
    const mod = await import('./swMediaAuth');

    await expect(mod.probeSWMediaAuthSupport()).resolves.toBe(false);
    expect(mod.getCachedSWMediaAuthSupport()).toBe(false);
  });

  it('resolves true and notifies listeners when the service worker answers the probe', async () => {
    platform.hasServiceWorker.mockReturnValue(true);
    const postMessage = vi.fn<(...args: unknown[]) => void>((...args: unknown[]) => {
      const [port] = args[1] as MessagePort[];
      port?.postMessage({ type: 'swMediaAuth', supported: true, version: 1 });
    });
    stubServiceWorker({ postMessage });
    const mod = await import('./swMediaAuth');
    const listener = vi.fn<(supported: boolean) => void>();
    const unsubscribe = mod.subscribeSWMediaAuthSupport(listener);

    await expect(mod.probeSWMediaAuthSupport()).resolves.toBe(true);

    expect(mod.getCachedSWMediaAuthSupport()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);
    unsubscribe();
  });

  it('resolves false when the probe times out', async () => {
    platform.hasServiceWorker.mockReturnValue(true);
    stubServiceWorker({ postMessage: vi.fn<() => void>() });
    const mod = await import('./swMediaAuth');

    await expect(mod.probeSWMediaAuthSupport()).resolves.toBe(false);
    expect(mod.getCachedSWMediaAuthSupport()).toBe(false);
  }, 10_000);

  it('resolves false when posting to a stale controller throws', async () => {
    platform.hasServiceWorker.mockReturnValue(true);
    const postMessage = vi.fn<() => void>(() => {
      throw new DOMException('The service worker is redundant', 'InvalidStateError');
    });
    stubServiceWorker({ postMessage });
    const mod = await import('./swMediaAuth');
    const listener = vi.fn<(supported: boolean) => void>();
    mod.subscribeSWMediaAuthSupport(listener);

    await expect(mod.probeSWMediaAuthSupport()).resolves.toBe(false);

    expect(mod.getCachedSWMediaAuthSupport()).toBe(false);
    expect(listener).toHaveBeenCalledWith(false);
  });

  it('serves subsequent probes from cache for the same controller', async () => {
    platform.hasServiceWorker.mockReturnValue(true);
    const postMessage = vi.fn<(...args: unknown[]) => void>((...args: unknown[]) => {
      const [port] = args[1] as MessagePort[];
      port?.postMessage({ type: 'swMediaAuth', supported: true, version: 1 });
    });
    stubServiceWorker({ postMessage });
    const mod = await import('./swMediaAuth');

    await expect(mod.probeSWMediaAuthSupport()).resolves.toBe(true);
    await expect(mod.probeSWMediaAuthSupport()).resolves.toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
