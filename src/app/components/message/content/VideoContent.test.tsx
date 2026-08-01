import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VideoContent } from './VideoContent';

const mocks = vi.hoisted(() => ({ tauri: true }));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => mocks.tauri,
  // Real convertFileSrc percent-encodes the target into the URI path.
  convertFileSrc: (url: string, protocol: string) =>
    `${protocol}://localhost/${encodeURIComponent(url)}`,
}));

vi.mock('$hooks/useMatrixClient', () => ({
  useMatrixClient: () => ({}),
}));
vi.mock('$hooks/useMediaAuthentication', () => ({
  useMediaAuthentication: () => true,
}));
vi.mock('$hooks/useObjectURL', () => ({
  useCreateObjectURL: () => (value: string) => value,
}));

const SABLE_MEDIA_URL =
  'sable-media://https://hs.example/_matrix/client/v1/media/download/example.org/vid123?__sable_media_cache=3';
vi.mock('$utils/matrix', () => ({
  mxcUrlToHttp: () => SABLE_MEDIA_URL,
  rewriteAuthenticatedMediaUrl: (url: string | null) => url,
  downloadMedia: vi.fn<() => Promise<ArrayBuffer>>(),
  downloadEncryptedMedia: vi.fn<() => Promise<ArrayBuffer>>(),
  decryptFile: vi.fn<() => Promise<ArrayBuffer>>(),
}));
vi.mock('$utils/swMediaAuth', () => ({
  probeSWMediaAuthSupport: async () => true,
}));

describe('VideoContent', () => {
  it('renders a distinct sable-media src on retry in Tauri', async () => {
    const srcs: string[] = [];
    render(
      <VideoContent
        body="clip"
        mimeType="video/mp4"
        url="mxc://example.org/vid123"
        info={{ w: 640, h: 360, duration: 1000 }}
        renderVideo={(props) => {
          srcs.push(props.src);
          return (
            <video data-testid="video" src={props.src} onError={props.onError}>
              <track kind="captions" />
            </video>
          );
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));

    const video = await screen.findByTestId('video');
    const initialSrc = srcs[srcs.length - 1];
    expect(initialSrc).toBe(SABLE_MEDIA_URL);

    fireEvent.error(video);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      const retriedSrc = srcs[srcs.length - 1] ?? '';
      expect(retriedSrc).not.toBe(initialSrc);
      // The decoded scheme path is the `target` Rust feeds into cache_key.
      const schemePath = retriedSrc.replace(/^sable-media:\/\/localhost\//, '').split('?')[0]!;
      expect(decodeURIComponent(schemePath)).toMatch(
        /^https:\/\/hs\.example\/_matrix\/client\/v1\/media\/download\/example\.org\/vid123#__sable_media_retry=\d+$/
      );
      expect(retriedSrc).toContain('__sable_media_cache=3');
    });
  });
});
