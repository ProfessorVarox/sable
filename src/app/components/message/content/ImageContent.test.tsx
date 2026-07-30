import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImageContent } from './ImageContent';

const screenMocks = vi.hoisted(() => ({ isMobile: true }));
vi.mock('$hooks/useScreenSize', () => ({
  ScreenSize: { Desktop: 'Desktop', Tablet: 'Tablet', Mobile: 'Mobile' },
  useScreenSizeOptionally: () => (screenMocks.isMobile ? 'Mobile' : 'Desktop'),
}));

vi.mock('$hooks/useMatrixClient', () => ({
  useMatrixClient: () => ({}),
}));
vi.mock('$hooks/useMediaAuthentication', () => ({
  useMediaAuthentication: () => false,
}));
vi.mock('$hooks/useFavoriteGifs', () => ({
  useFavoriteGifs: () => ({ gifs: [] }),
}));
vi.mock('$hooks/useRenderableMediaUrl', () => ({
  useRenderableMediaUrl: (url: string | undefined) => url,
}));
vi.mock('$hooks/useObjectURL', () => ({
  useCreateObjectURL: () => (value: string) => value,
}));

const imageContent = (
  <ImageContent
    url="https://example.com/image.png"
    renderImage={() => <img alt="preview" />}
    renderViewer={() => <div>viewer</div>}
  />
);

const touchTap = (target: Element) => {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: 10,
    clientY: 10,
  });
  fireEvent.pointerUp(target, {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: 10,
    clientY: 10,
  });
  fireEvent.click(target);
};

// Mirrors Message.tsx: an enclosing long-press timer that media gestures must
// not trigger (media containers are marked `data-gestures="ignore"`).
const renderWithLongPress = (children: ReactNode, onLongPress: () => void) =>
  render(
    <div
      onTouchStart={(evt) => {
        const target = evt.target as Element;
        if (target.closest('[data-gestures="ignore"]')) return;
        setTimeout(onLongPress, 500);
      }}
    >
      {children}
    </div>
  );

describe('ImageContent', () => {
  it('opens the viewer after one tap on idle media', async () => {
    render(imageContent);

    touchTap(screen.getByRole('button', { name: 'View' }));

    await waitFor(() => expect(screen.getByText('viewer')).toBeInTheDocument());
    expect(screen.getByAltText('preview').closest('[data-gestures="ignore"]')).not.toBeNull();
  });

  it('does not mount hover controls for touch pointer entry', () => {
    render(imageContent);

    const media = screen.getByRole('button', { name: 'View' }).closest('[data-gestures="ignore"]');
    expect(media).not.toBeNull();
    fireEvent.pointerEnter(media!, { pointerType: 'touch' });
    expect(screen.queryByTitle('Hide Image')).not.toBeInTheDocument();

    fireEvent.pointerEnter(media!, { pointerType: 'mouse' });
    expect(screen.getByTitle('Hide Image')).toBeInTheDocument();
  });

  it('keeps media touches out of an enclosing message long-press timer', () => {
    vi.useFakeTimers();
    const messageLongPress = vi.fn<() => void>();
    try {
      renderWithLongPress(imageContent, messageLongPress);

      const view = screen.getByRole('button', { name: 'View' });
      fireEvent.touchStart(view, {
        touches: [{ identifier: 1, clientX: 10, clientY: 10 }],
      });
      touchTap(view);
      vi.advanceTimersByTime(600);

      expect(messageLongPress).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still allows ordinary message touches to start long press', () => {
    vi.useFakeTimers();
    const messageLongPress = vi.fn<() => void>();
    try {
      renderWithLongPress(<span>ordinary message</span>, messageLongPress);

      fireEvent.touchStart(screen.getByText('ordinary message'), {
        touches: [{ identifier: 1, clientX: 10, clientY: 10 }],
      });
      vi.advanceTimersByTime(600);

      expect(messageLongPress).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
