import { afterEach, describe, expect, it, vi } from 'vitest';

const isTauri = vi.hoisted(() => vi.fn<() => boolean>());

vi.mock('@tauri-apps/api/core', () => ({ isTauri }));

import {
  enablePushNotifications,
  disablePushNotifications,
  togglePusher,
} from './PushNotifications';

const matrixClient = vi.hoisted(() => ({
  getAccessToken: vi.fn<() => string>(() => 'token'),
}));
const clientConfig = {} as never;

afterEach(() => {
  vi.clearAllMocks();
});

describe('enablePushNotifications', () => {
  it('no-ops in the Tauri runtime instead of throwing', async () => {
    isTauri.mockReturnValue(true);

    await expect(
      enablePushNotifications(matrixClient as never, clientConfig, [
        null,
        vi.fn<(sub: unknown) => void>(),
      ])
    ).resolves.toBeUndefined();
  });
});

describe('disablePushNotifications', () => {
  it('no-ops in the Tauri runtime', async () => {
    isTauri.mockReturnValue(true);

    await expect(
      disablePushNotifications(matrixClient as never, clientConfig, [
        null,
        vi.fn<(sub: unknown) => void>(),
      ])
    ).resolves.toBeUndefined();
  });
});

describe('togglePusher', () => {
  it('does not throw in the Tauri runtime when push is enabled', async () => {
    isTauri.mockReturnValue(true);

    await expect(
      togglePusher(matrixClient as never, clientConfig, true, true, [
        null,
        vi.fn<(sub: unknown) => void>(),
      ])
    ).resolves.toBeUndefined();
  });
});
