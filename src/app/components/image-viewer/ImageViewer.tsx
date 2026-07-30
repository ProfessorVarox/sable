import type { MouseEventHandler } from 'react';
import { useEffect, useRef, useState } from 'react';
import classNames from 'classnames';
import { Box, Chip, Header, IconButton, Menu, MenuItem, Text, as, config, toRem } from 'folds';
import {
  ArrowLeft,
  ArrowsClockwise,
  Download,
  Image,
  Minus,
  Plus,
  menuIcon,
  phosphorSizeRem,
  sizedIcon,
} from '$components/icons/phosphor';
import { Image as MediaImage } from '$components/media';
import { useImageGestures } from '$hooks/useImageGestures';
import { useMenuAnchor } from '$hooks/useMenuAnchor';
import { useDismissOnBack } from '$utils/androidBack';
import { useSetting } from '$state/hooks/settings';
import { isPixelatedRendering, settingsAtom } from '$state/settings';
import { showToast } from '$state/toast';
import { downloadMedia } from '$utils/matrix';
import * as css from './ImageViewer.css';
import type { IImageInfo } from '$types/matrix/common';
import { CheckerboardIcon, CopyIcon, DownloadIcon } from '@phosphor-icons/react';
import { copyImageToClipboard } from '$utils/dom';
import { getDownloadFilename, saveFileToDevice, saveMediaToGallery } from '$utils/download';
import { ResponsiveMenu } from '$components/ResponsiveMenu';
import { isAndroidTauri, iosApp } from '$utils/platform';
import { ScreenSize, useScreenSizeOptionally } from '$hooks/useScreenSize';
import { useMobileTapActivation } from '$hooks/useMobileTapActivation';

type ImageViewerProps = {
  alt: string;
  filename?: string;
  src: string;
  requestClose: () => void;
  info?: IImageInfo;
};

export const ImageViewer = as<'div', ImageViewerProps>(
  ({ className, alt, filename, src, requestClose, info, ...props }, ref) => {
    const zoomInputRef = useRef<HTMLInputElement>(null);
    const [pixelatedImageRendering] = useSetting(settingsAtom, 'pixelatedImageRendering');
    const isMobile = useScreenSizeOptionally() === ScreenSize.Mobile;

    // Android back closes the viewer instead of navigating away.
    useDismissOnBack(requestClose);

    const [isImageReady, setIsImageReady] = useState(false);
    const [isEditingZoom, setIsEditingZoom] = useState(false);
    const [zoomInput, setZoomInput] = useState('100');
    const [isPixelated, setIsPixelated] = useState(
      isPixelatedRendering(pixelatedImageRendering, info)
    );

    const {
      transforms,
      cursor,
      handleWheel,
      onPointerDown,
      resetTransforms,
      zoomIn,
      zoomOut,
      setZoom,
      fitRatio,
      imageRef,
      containerRef,
      handleImageLoad,
      handleImageDimensions,
      enableResizeWithWindow,
    } = useImageGestures(true, 0.2, 0.1);
    useEffect(() => {
      setIsImageReady(false);
      enableResizeWithWindow();
      setIsEditingZoom(false);
      setZoomInput('100');
      if (imageRef.current) {
        imageRef.current = null;
      }
    }, [src, enableResizeWithWindow, imageRef]);

    // When not actively editing the zoom input, keep it in sync with the current zoom level.
    useEffect(() => {
      if (!isEditingZoom) {
        setZoomInput(Math.round(transforms.zoom * 100).toString());
      }
    }, [isEditingZoom, transforms.zoom]);

    // When entering zoom edit mode, focus the input automatically.
    useEffect(() => {
      if (isEditingZoom) {
        zoomInputRef.current?.focus();
      }
    }, [isEditingZoom]);

    const galleryMimeType = info?.mimetype?.toLowerCase();
    // On iOS the primary action saves trusted images straight to Photos (PhotoKit).
    const iosSaveToPhotos = iosApp() && (galleryMimeType?.startsWith('image/') ?? false);
    const downloadFilename = getDownloadFilename(filename, alt, 'image');

    const handleDownload = async () => {
      if (iosSaveToPhotos) {
        await saveMediaToGallery(src, downloadFilename, galleryMimeType!);
        return;
      }
      let fileContent: Blob;
      try {
        fileContent = await downloadMedia(src);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        showToast(`Failed to download file: ${message}`);
        return;
      }
      await saveFileToDevice(fileContent, downloadFilename);
    };

    const menu = useMenuAnchor<HTMLDivElement>();
    const canSaveToGallery = isAndroidTauri() && (galleryMimeType?.startsWith('image/') ?? false);

    const closeActivation = useMobileTapActivation(isMobile, requestClose);
    const pixelatedActivation = useMobileTapActivation(isMobile, () =>
      setIsPixelated(!isPixelated)
    );
    const originalSizeActivation = useMobileTapActivation(isMobile, () => setZoom(1));
    const resetZoomActivation = useMobileTapActivation(isMobile, () => {
      resetTransforms();
      enableResizeWithWindow();
      setZoom(fitRatio);
    });
    const zoomOutActivation = useMobileTapActivation(isMobile, zoomOut);
    const zoomInputActivation = useMobileTapActivation(isMobile, () => {
      setZoomInput(Math.round(transforms.zoom * 100).toString());
      setIsEditingZoom(true);
    });
    const zoomInActivation = useMobileTapActivation(isMobile, zoomIn);
    const downloadActivation = useMobileTapActivation(isMobile, () => {
      void handleDownload();
    });
    const copyImageActivation = useMobileTapActivation(isMobile, () => {
      menu.close();
      void downloadMedia(src).then(copyImageToClipboard);
    });
    const saveImageActivation = useMobileTapActivation(isMobile, () => {
      menu.close();
      void handleDownload();
    });
    const galleryActivation = useMobileTapActivation(isMobile, () => {
      menu.close();
      void saveMediaToGallery(src, downloadFilename, galleryMimeType!);
    });

    const handleContextMenu: MouseEventHandler<HTMLDivElement> = (evt) => {
      if (evt.altKey || !window.getSelection()?.isCollapsed) return;
      const tag = (evt.target as HTMLElement).tagName;
      if (typeof tag === 'string' && tag.toLowerCase() === 'a') return;
      menu.triggerProps.onContextMenu(evt);
    };

    return (
      <>
        <ResponsiveMenu
          anchor={menu.anchor}
          requestClose={menu.close}
          align="Start"
          offset={0}
          menu={
            <Menu variant="Surface" style={{ maxWidth: toRem(160), width: '100vw' }}>
              <Box direction="Column" gap="100" style={{ padding: config.space.S100 }}>
                <MenuItem
                  as="button"
                  radii="300"
                  size="300"
                  after={menuIcon(CopyIcon)}
                  {...copyImageActivation}
                >
                  <Text size="T300" style={{ flexGrow: 1 }}>
                    Copy image
                  </Text>
                </MenuItem>
                <MenuItem
                  as="button"
                  radii="300"
                  size="300"
                  after={menuIcon(DownloadIcon)}
                  {...saveImageActivation}
                >
                  <Text size="T300" style={{ flexGrow: 1 }}>
                    Save image
                  </Text>
                </MenuItem>
                {canSaveToGallery && (
                  <MenuItem
                    as="button"
                    radii="300"
                    size="300"
                    after={menuIcon(DownloadIcon)}
                    {...galleryActivation}
                  >
                    <Text size="T300" style={{ flexGrow: 1 }}>
                      Save to Gallery
                    </Text>
                  </MenuItem>
                )}
              </Box>
            </Menu>
          }
        />
        <Box
          className={classNames(css.ImageViewer, className)}
          direction="Column"
          data-gestures="ignore"
          {...props}
          ref={ref}
        >
          <Header className={css.ImageViewerHeader} size="400">
            <Box grow="Yes" alignItems="Center" gap="200">
              <IconButton size="300" radii="300" {...closeActivation}>
                {sizedIcon(ArrowLeft, '200')}
              </IconButton>
              <Text size="T300" truncate>
                {alt}
              </Text>
            </Box>
            <Box shrink="No" alignItems="Center" gap="200">
              <IconButton
                variant="Surface"
                size="300"
                radii="Pill"
                {...pixelatedActivation}
                aria-label="Toggle Pixelation"
                title={`Turn ${isPixelated ? 'Anti-aliasing' : 'Pixelation'} on`}
              >
                <CheckerboardIcon
                  size={phosphorSizeRem(20)}
                  weight={isPixelated ? 'duotone' : 'fill'}
                />
              </IconButton>
              <IconButton
                variant="Surface"
                style={{
                  // Only show when the image isn't already larger than the container
                  // and isn't already at 100% zoom
                  // (Otherwise, the Reset Zoom button does the same thing)
                  display: fitRatio !== 1 && transforms.zoom !== 1 ? 'flex' : 'none',
                }}
                size="300"
                radii="Pill"
                {...originalSizeActivation}
                aria-label="View Original Size"
                title="View Original Size"
              >
                {sizedIcon(Image, '200')}
              </IconButton>
              <IconButton
                variant="Surface"
                style={{
                  // Only show when the image has had any transforms applied (zoom or pan)
                  display:
                    transforms.zoom !== fitRatio || transforms.pan.x !== 0 || transforms.pan.y !== 0
                      ? 'flex'
                      : 'none',
                }}
                size="300"
                radii="Pill"
                {...resetZoomActivation}
                aria-label="Reset Zoom"
                title="Zoom to Fill Container"
              >
                {sizedIcon(ArrowsClockwise, '200')}
              </IconButton>
              <IconButton
                variant={transforms.zoom < 1 ? 'Success' : 'SurfaceVariant'}
                outlined={transforms.zoom < 1}
                size="300"
                radii="Pill"
                {...zoomOutActivation}
                aria-label="Zoom Out"
                title="Zoom Out"
              >
                {sizedIcon(Minus, '50')}
              </IconButton>
              <Chip
                variant="SurfaceVariant"
                radii="Pill"
                style={{
                  // For zoom levels below 100%, keep the pill at the same size as it would be at 100% zoom.
                  // This prevents the Zoom Out button from moving from the pill changing size.
                  // 4em should be generous enough to fit without manually determining the width of the text.
                  minWidth: '4em',
                }}
                {...zoomInputActivation}
                title="Update Zoom"
              >
                <Text
                  size="B300"
                  style={{
                    cursor: 'text',
                    margin: 'auto',
                  }}
                >
                  {isEditingZoom ? (
                    <span>
                      <input
                        className={css.ImageViewerInput}
                        ref={zoomInputRef}
                        type="text"
                        aria-label="Set Zoom Level"
                        value={zoomInput}
                        onChange={(e) => {
                          setZoomInput(e.target.value);
                        }}
                        onBlur={() => {
                          const next = parseInt(zoomInput, 10);
                          if (!Number.isNaN(next)) {
                            setZoom(next / 100);
                          }
                          setIsEditingZoom(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const next = parseInt(zoomInput, 10);
                            if (!Number.isNaN(next)) {
                              setZoom(next / 100);
                            }
                            setIsEditingZoom(false);
                          }
                        }}
                      />
                      <span>%</span>
                    </span>
                  ) : (
                    `${Math.round(transforms.zoom * 100)}%`
                  )}
                </Text>
              </Chip>
              <IconButton
                variant={transforms.zoom > 1 ? 'Success' : 'SurfaceVariant'}
                outlined={transforms.zoom > 1}
                size="300"
                radii="Pill"
                {...zoomInActivation}
                aria-label="Zoom In"
                title="Zoom In"
              >
                {sizedIcon(Plus, '50')}
              </IconButton>
              <Chip
                variant="Primary"
                {...downloadActivation}
                radii="300"
                before={sizedIcon(Download, '50')}
                outlined
              >
                <Text size="B300">{iosSaveToPhotos ? 'Save to Photos' : 'Download'}</Text>
              </Chip>
            </Box>
          </Header>
          <Box
            grow="Yes"
            ref={containerRef}
            onWheel={handleWheel}
            className={css.ImageViewerContent}
            data-gestures="ignore"
            justifyContent="Center"
            alignItems="Center"
            style={{ overflow: 'hidden', touchAction: 'none', cursor }}
            onPointerDown={onPointerDown}
            onContextMenu={handleContextMenu}
            onTouchStart={menu.triggerProps.onTouchStart}
            onTouchEnd={menu.triggerProps.onTouchEnd}
            onTouchMove={menu.triggerProps.onTouchMove}
            onTouchCancel={menu.triggerProps.onTouchCancel}
          >
            <MediaImage
              ref={imageRef}
              className={classNames(css.ImageViewerImg, isPixelated && css.ImageViewerImgPixelated)}
              draggable={false}
              data-gestures="ignore"
              style={{
                cursor,
                opacity: isImageReady ? 1 : 0, // Hide image until fit to container
                transform: `translate(${transforms.pan.x}px, ${transforms.pan.y}px) scale(${transforms.zoom})`,
              }}
              src={src}
              alt={alt}
              info={info}
              pixelated={isPixelated}
              onPointerDown={onPointerDown}
              onLoad={(event: React.SyntheticEvent<HTMLImageElement>) => {
                handleImageLoad(event);
                setIsImageReady(true);
              }}
              onLottieLoad={(canvas) => {
                handleImageDimensions(
                  info?.w ?? canvas?.width ?? 0,
                  info?.h ?? canvas?.height ?? 0
                );
                setIsImageReady(true);
              }}
            />
          </Box>
        </Box>
      </>
    );
  }
);
