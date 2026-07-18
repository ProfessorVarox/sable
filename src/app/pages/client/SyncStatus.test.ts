import { describe, expect, it } from 'vitest';
import { SyncState } from '$types/matrix-sdk';
import { shouldShowConnecting } from './SyncStatus';

describe('shouldShowConnecting', () => {
  it('hides ordinary initial connection states', () => {
    expect(shouldShowConnecting(false, SyncState.Prepared, null)).toBe(false);
    expect(shouldShowConnecting(false, SyncState.Syncing, SyncState.Prepared)).toBe(false);
    expect(shouldShowConnecting(false, SyncState.Catchup, null)).toBe(false);
  });

  it('shows recovery progress after a client has previously connected', () => {
    expect(shouldShowConnecting(true, SyncState.Catchup, SyncState.Reconnecting)).toBe(true);
    expect(shouldShowConnecting(true, SyncState.Syncing, SyncState.Catchup)).toBe(true);
  });

  it('hides the banner during steady syncing', () => {
    expect(shouldShowConnecting(true, SyncState.Syncing, SyncState.Syncing)).toBe(false);
  });
});
