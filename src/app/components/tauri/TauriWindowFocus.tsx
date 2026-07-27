import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import { setNativeWindowFocused } from '$utils/dom';
import { createLogger } from '$utils/debug';

const log = createLogger('TauriWindowFocus');

// Mobile has no window focus to report; the DOM path stays authoritative there.
const DESKTOP = new Set(['windows', 'linux', 'macos']);

export function TauriWindowFocus() {
  useEffect(() => {
    if (!isTauri() || !DESKTOP.has(osType())) return undefined;

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // isFocused() is an IPC round-trip and can resolve after a newer focus change.
    let sawEvent = false;

    const appWindow = getCurrentWindow();

    appWindow
      .isFocused()
      .then((focused) => {
        if (!cancelled && !sawEvent) setNativeWindowFocused(focused);
      })
      .catch((error: unknown) => log.warn('Failed to read initial window focus:', error));

    appWindow
      .onFocusChanged(({ payload }) => {
        sawEvent = true;
        setNativeWindowFocused(payload);
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => log.warn('Failed to subscribe to window focus:', error));

    return () => {
      cancelled = true;
      unlisten?.();
      setNativeWindowFocused(undefined);
    };
  }, []);

  return null;
}
