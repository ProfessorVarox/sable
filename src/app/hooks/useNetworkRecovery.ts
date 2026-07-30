import { useCallback, useEffect, useRef } from 'react';
import { onlineManager } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import type { MatrixClient } from '$types/matrix-sdk';
import type { NudgeReason } from '$client/reconnect';
import { nudgeReconnect } from '$client/reconnect';
import { useSyncState } from './useSyncState';

// Sync fires on every poll response: at most 45s apart on sliding, 30s classic.
const SYNC_STALL_MS = 75_000;
const STALL_CHECK_INTERVAL_MS = 10_000;
// Visibility alone is not evidence the network changed.
const VISIBLE_STALE_MS = 30_000;

export const useNetworkRecovery = (mx: MatrixClient | undefined): void => {
  const lastSyncAtRef = useRef(Date.now());

  const nudge = useCallback(
    (reason: NudgeReason): boolean => {
      if (!mx) return false;
      onlineManager.setOnline(true);
      return nudgeReconnect(mx, reason);
    },
    [mx]
  );

  useSyncState(
    mx,
    useCallback(() => {
      lastSyncAtRef.current = Date.now();
    }, [])
  );

  useEffect(() => {
    if (!mx) return undefined;

    const onOnline = () => nudge('online');
    const onVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - lastSyncAtRef.current >= VISIBLE_STALE_MS
      ) {
        nudge('visible');
      }
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);

    const stallCheck = window.setInterval(() => {
      if (Date.now() - lastSyncAtRef.current < SYNC_STALL_MS) return;
      if (nudge('stalled')) lastSyncAtRef.current = Date.now();
    }, STALL_CHECK_INTERVAL_MS);

    const unlisten = isTauri() ? listen('app-resumed', () => nudge('resumed')) : undefined;

    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(stallCheck);
      unlisten?.then((off) => off());
    };
  }, [mx, nudge]);
};
