import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceiveSelfDeviceVerification } from './DeviceVerification';

const getVerificationRequestsToDeviceInProgress = vi.hoisted(() =>
  vi.fn<(userId: string) => unknown[]>()
);
const listeners = vi.hoisted(() => new Map<string, (request: unknown) => void>());

vi.mock('$hooks/useMatrixClient', () => ({
  useMatrixClient: () => ({
    getSafeUserId: () => '@me:example.org',
    getCrypto: () => ({ getVerificationRequestsToDeviceInProgress }),
    on: (event: string, handler: (request: unknown) => void) => listeners.set(event, handler),
    removeListener: (event: string) => listeners.delete(event),
  }),
}));

vi.mock('$components/modal-overlay/ModalOverlay', () => ({
  ModalOverlay: ({
    children,
    deactivateCloses,
  }: {
    children: React.ReactNode;
    deactivateCloses?: boolean;
  }) => <div data-deactivate-closes={String(deactivateCloses)}>{children}</div>,
}));

const pendingRequest = {
  isSelfVerification: true,
  initiatedByMe: false,
  pending: true,
  phase: 1,
  on: vi.fn<() => void>(),
  removeListener: vi.fn<() => void>(),
};

const renderReceiver = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReceiveSelfDeviceVerification />
    </QueryClientProvider>
  );

describe('ReceiveSelfDeviceVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
  });

  it('shows a request that arrived before it was mounted', async () => {
    getVerificationRequestsToDeviceInProgress.mockReturnValue([pendingRequest]);

    renderReceiver();

    await waitFor(() => expect(screen.getByText('Device Verification')).toBeInTheDocument());
  });

  it('does not treat unmounting as the user cancelling', async () => {
    const cancel = vi.fn<() => Promise<void>>(async () => undefined);
    getVerificationRequestsToDeviceInProgress.mockReturnValue([{ ...pendingRequest, cancel }]);

    const { unmount } = renderReceiver();
    await waitFor(() => expect(screen.getByText('Device Verification')).toBeInTheDocument());
    expect(
      screen.getByText('Device Verification').closest('[data-deactivate-closes]')
    ).toHaveAttribute('data-deactivate-closes', 'false');

    unmount();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('ignores a request this device started', async () => {
    getVerificationRequestsToDeviceInProgress.mockReturnValue([
      { ...pendingRequest, initiatedByMe: true },
    ]);

    renderReceiver();

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(screen.queryByText('Device Verification')).toBeNull();
  });
});
