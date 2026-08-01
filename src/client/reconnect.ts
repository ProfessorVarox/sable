import type { MatrixClient } from '$types/matrix-sdk';
import { createDebugLogger } from '$utils/debugLogger';
import { getSlidingSyncManager } from './initMatrix';

const debugLog = createDebugLogger('reconnect');

const NUDGE_THROTTLE_MS = 3000;

const lastNudgeAt = new WeakMap<MatrixClient, number>();

export type NudgeReason = 'online' | 'visible' | 'resumed' | 'stalled' | 'retry';

/**
 * Sliding sync aborts the long-poll and re-requests with no backoff sleep.
 * Classic has no public abort, so this only collapses an existing keepalive
 * backoff — a hung classic poll still waits out its 110s localTimeout.
 */
export const nudgeReconnect = (
  mx: MatrixClient,
  reason: NudgeReason,
  opts?: { force?: boolean }
): boolean => {
  if (!mx.clientRunning) return false;

  const now = Date.now();
  const last = lastNudgeAt.get(mx);
  if (!opts?.force && last !== undefined && now - last < NUDGE_THROTTLE_MS) return false;
  lastNudgeAt.set(mx, now);

  const slidingSync = getSlidingSyncManager(mx)?.slidingSync;
  if (slidingSync) {
    slidingSync.resend();
  } else {
    mx.retryImmediately();
  }

  debugLog.info('network', `Nudged sync transport (${reason})`, {
    reason,
    transport: slidingSync ? 'sliding' : 'classic',
  });
  return true;
};
