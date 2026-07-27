import type { SyntheticEvent, WheelEvent } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FileSaver from 'file-saver';
import { ImageViewer } from './ImageViewer';

const downloadMedia = vi.fn<(src: string) => Promise<Blob>>();
const gestureMocks = vi.hoisted(() => ({
  onPointerDown: vi.fn<(event: React.PointerEvent) => void>(),
}));

vi.mock('$hooks/useImageGestures', () => ({
  useImageGestures: () => ({
    transforms: { zoom: 1, pan: { x: 0, y: 0 } },
    cursor: 'grab',
    fitRatio: 1,
    imageRef: { current: null },
    containerRef: { current: null },
    handleWheel: vi.fn<(event: WheelEvent) => void>(),
    onPointerDown: gestureMocks.onPointerDown,
    handleImageLoad: vi.fn<(event: SyntheticEvent<HTMLImageElement>) => void>(),
    setZoom: vi.fn<(next: number) => void>(),
    resetTransforms: vi.fn<() => void>(),
    zoomIn: vi.fn<() => void>(),
    zoomOut: vi.fn<() => void>(),
    enableResizeWithWindow: vi.fn<() => void>(),
  }),
}));

vi.mock('$utils/matrix', () => ({
  downloadMedia: (...args: [string]) => downloadMedia(...args),
}));

vi.mock('file-saver', () => ({
  default: {
    saveAs: vi.fn<(data: Blob | string, filename?: string) => void>(),
  },
}));

vi.mock('$hooks/useScreenSize', () => ({
  ScreenSize: { Desktop: 'Desktop', Tablet: 'Tablet', Mobile: 'Mobile' },
  useScreenSizeContext: () => 'Desktop',
  useScreenSizeOptionally: () => 'Desktop',
}));

describe('ImageViewer', () => {
  it('downloads media without passing a media token argument', async () => {
    downloadMedia.mockResolvedValue(new Blob(['image']));

    render(
      <ImageViewer
        alt="kitten.png"
        src="https://example.org/kitten.png"
        requestClose={vi.fn<() => void>()}
      />
    );

    fireEvent.click(screen.getByText('Download'));

    await waitFor(() => {
      expect(downloadMedia).toHaveBeenCalledWith('https://example.org/kitten.png');
    });
    expect(FileSaver.saveAs).toHaveBeenCalledWith(expect.any(Blob), 'kitten.png');
  });
});

vi.mock('$components/media', async () => {
  const { forwardRef } = await import('react');
  return {
    Image: forwardRef<
      HTMLImageElement | HTMLCanvasElement,
      React.ImgHTMLAttributes<HTMLImageElement> & { info?: { mimetype?: string } }
    >(({ alt, info, ...props }, ref) =>
      info?.mimetype === 'application/x-tgsticker' ? (
        <canvas
          aria-label={alt}
          {...(props as React.CanvasHTMLAttributes<HTMLCanvasElement>)}
          ref={ref as React.ForwardedRef<HTMLCanvasElement>}
        />
      ) : (
        <img alt={alt} {...props} ref={ref as React.ForwardedRef<HTMLImageElement>} />
      )
    ),
  };
});

describe('ImageViewer', () => {
  it('renders the fullscreen image without crashing', () => {
    render(<ImageViewer alt="demo" src="https://example.com/demo.png" requestClose={() => {}} />);

    expect(screen.getByAltText('demo')).toBeInTheDocument();
  });

  it('starts viewer gestures from the rendered lottie canvas', () => {
    gestureMocks.onPointerDown.mockClear();
    render(
      <ImageViewer
        alt="animated sticker"
        src="https://example.com/sticker"
        info={{ mimetype: 'application/x-tgsticker' }}
        requestClose={() => {}}
      />
    );

    const canvas = screen.getByLabelText('animated sticker');
    expect(canvas.tagName).toBe('CANVAS');
    fireEvent.pointerDown(canvas);
    expect(gestureMocks.onPointerDown).toHaveBeenCalled();
  });
});
