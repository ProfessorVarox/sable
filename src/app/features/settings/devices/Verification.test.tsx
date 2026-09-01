import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretStorageKeyContent } from '$types/matrix/accountData';
import { VerifyCurrentDeviceTile } from './Verification';

const requestOwnUserVerification = vi.hoisted(() => vi.fn<() => Promise<unknown>>());

vi.mock('$hooks/useMatrixClient', () => ({
  useMatrixClient: () => ({
    getSafeUserId: () => '@me:example.org',
    getCrypto: () => ({ requestOwnUserVerification }),
  }),
}));

vi.mock('$components/DeviceVerification', () => ({
  DeviceVerification: () => <div>device verification dialog</div>,
}));

const KEY_ID = 'key-id';
const KEY_CONTENT = { algorithm: 'm.secret_storage.v1.aes-hmac-sha2' } as SecretStorageKeyContent;

const renderTile = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <VerifyCurrentDeviceTile secretStorageKeyId={KEY_ID} secretStorageKeyContent={KEY_CONTENT} />
    </QueryClientProvider>
  );

describe('VerifyCurrentDeviceTile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestOwnUserVerification.mockResolvedValue({});
  });

  it('starts a self verification so an unverified device is not stuck with the recovery key', async () => {
    renderTile();

    fireEvent.click(screen.getByRole('button', { name: /Verify with Device/i }));

    await waitFor(() => expect(requestOwnUserVerification).toHaveBeenCalledOnce());
    expect(await screen.findByText('device verification dialog')).toBeInTheDocument();
  });

  it('reports why the request failed instead of silently doing nothing', async () => {
    requestOwnUserVerification.mockRejectedValue(new Error('no cross-signing identity'));
    renderTile();

    fireEvent.click(screen.getByRole('button', { name: /Verify with Device/i }));

    expect(await screen.findByText('no cross-signing identity')).toBeInTheDocument();
  });
});
