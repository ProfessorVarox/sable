import type { MatrixClient } from '$types/matrix-sdk';
import { SyncState } from '$types/matrix-sdk';
import { useCallback, useRef, useState } from 'react';
import { Box, config, Line, Text } from 'folds';
import * as Sentry from '@sentry/react';
import { useSyncState } from '$hooks/useSyncState';
import { ContainerColor } from '$styles/ContainerColor.css';

type StateData = {
  current: SyncState | null;
  previous: SyncState | null | undefined;
  showConnecting: boolean;
};

export const shouldShowConnecting = (
  hasConnected: boolean,
  current: SyncState | null,
  previous: SyncState | null | undefined
): boolean =>
  hasConnected &&
  (current === SyncState.Prepared ||
    current === SyncState.Syncing ||
    current === SyncState.Catchup) &&
  previous !== SyncState.Syncing;

type SyncStatusProps = {
  mx: MatrixClient;
};
export function SyncStatus({ mx }: SyncStatusProps) {
  const hasConnectedRef = useRef(false);
  const [stateData, setStateData] = useState<StateData>({
    current: null,
    previous: undefined,
    showConnecting: false,
  });

  useSyncState(
    mx,
    useCallback((current, previous) => {
      const showConnecting = shouldShowConnecting(hasConnectedRef.current, current, previous);
      if (current === SyncState.Syncing) hasConnectedRef.current = true;

      setStateData((s) => {
        if (
          s.current === current &&
          s.previous === previous &&
          s.showConnecting === showConnecting
        ) {
          return s;
        }
        return { current, previous, showConnecting };
      });

      if (current === SyncState.Reconnecting || current === SyncState.Error) {
        Sentry.addBreadcrumb({
          category: 'sync',
          message: `Sync state changed to ${current}`,
          level: current === SyncState.Error ? 'error' : 'warning',
          data: { previous },
        });
        Sentry.metrics.count('sable.sync.degraded', 1, {
          attributes: { state: current },
        });
      }
    }, [])
  );

  if (stateData.showConnecting) {
    return (
      <Box direction="Column" shrink="No">
        <Box
          className={ContainerColor({ variant: 'Success' })}
          style={{ padding: `${config.space.S100} 0` }}
          alignItems="Center"
          justifyContent="Center"
        >
          <Text size="L400">Connecting...</Text>
        </Box>
        <Line variant="Success" size="300" />
      </Box>
    );
  }

  if (stateData.current === SyncState.Reconnecting) {
    return (
      <Box direction="Column" shrink="No">
        <Box
          className={ContainerColor({ variant: 'Warning' })}
          style={{ padding: `${config.space.S100} 0` }}
          alignItems="Center"
          justifyContent="Center"
        >
          <Text size="L400">Connection Lost! Reconnecting...</Text>
        </Box>
        <Line variant="Warning" size="300" />
      </Box>
    );
  }

  if (stateData.current === SyncState.Error) {
    return (
      <Box direction="Column" shrink="No">
        <Box
          className={ContainerColor({ variant: 'Critical' })}
          style={{ padding: `${config.space.S100} 0` }}
          alignItems="Center"
          justifyContent="Center"
        >
          <Text size="L400">Connection Lost!</Text>
        </Box>
        <Line variant="Critical" size="300" />
      </Box>
    );
  }

  return null;
}
