import { render, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeNotificationClickRouting } from './notifications';

// Controllable platform gates + a capturable notifications API. The click-routing
// effect only calls onNotificationClicked, so the rest of the plugin surface is stubbed
// to satisfy notifications.tsx's top-level imports.
const platform = vi.hoisted(() => ({
  isAndroidTauri: vi.fn<() => boolean>(),
  isIosTauri: vi.fn<() => boolean>(),
  isDesktopTauri: vi.fn<() => boolean>(),
}));

const notificationsApi = vi.hoisted(() => ({
  onNotificationClicked: vi
    .fn<() => Promise<{ unregister: () => void }>>()
    .mockResolvedValue({ unregister: () => {} }),
}));

const getTauriNotificationsApi = vi.hoisted(() =>
  vi.fn<() => Promise<typeof notificationsApi>>().mockResolvedValue(notificationsApi)
);

vi.mock('$features/settings/notifications/TauriNotificationsApiClient', () => ({
  getTauriNotificationsApi,
  isAndroidTauri: platform.isAndroidTauri,
  isIosTauri: platform.isIosTauri,
  isDesktopTauri: platform.isDesktopTauri,
  isNativeNotificationTauri: vi.fn<() => boolean>(() => false),
  sendNativeTauriNotification: vi.fn<() => void>(),
  IOS_INVITE_SOUND: 'invite.caf',
  IOS_NOTIFICATION_SOUND: 'notification.caf',
}));

function setPlatform(kind: 'android' | 'ios' | 'desktop' | 'web') {
  platform.isAndroidTauri.mockReturnValue(kind === 'android');
  platform.isIosTauri.mockReturnValue(kind === 'ios');
  platform.isDesktopTauri.mockReturnValue(kind === 'desktop');
}

function renderRouting() {
  return render(
    <Provider store={createStore()}>
      <MemoryRouter>
        <NativeNotificationClickRouting />
      </MemoryRouter>
    </Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getTauriNotificationsApi.mockResolvedValue(notificationsApi);
  notificationsApi.onNotificationClicked.mockResolvedValue({ unregister: () => {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('NativeNotificationClickRouting', () => {
  it('registers the click listener on Android (previously excluded by isNativeNotificationTauri)', async () => {
    setPlatform('android');
    renderRouting();

    await waitFor(() => {
      expect(notificationsApi.onNotificationClicked).toHaveBeenCalledTimes(1);
    });
  });

  it('registers the click listener on iOS', async () => {
    setPlatform('ios');
    renderRouting();

    await waitFor(() => {
      expect(notificationsApi.onNotificationClicked).toHaveBeenCalledTimes(1);
    });
  });

  it('registers the click listener on desktop', async () => {
    setPlatform('desktop');
    renderRouting();

    await waitFor(() => {
      expect(notificationsApi.onNotificationClicked).toHaveBeenCalledTimes(1);
    });
  });

  it('does not register the click listener on web', async () => {
    setPlatform('web');
    renderRouting();

    // The effect bails before calling getTauriNotificationsApi on web; flush any
    // pending microtasks before asserting nothing was scheduled.
    await Promise.resolve();

    expect(getTauriNotificationsApi).not.toHaveBeenCalled();
    expect(notificationsApi.onNotificationClicked).not.toHaveBeenCalled();
  });
});
