import { describe, expect, it, vi } from 'vitest';
import { MsgType, type MatrixClient } from '$types/matrix-sdk';
import type { TUploadItem } from '$state/room/roomInputDrafts';
import { TGS_MIMETYPE } from '$utils/mimeTypes';
import { getGalleryItemContent, getImageMsgContent } from './msgContent';

vi.mock('$utils/dom', () => ({
  getImageFileUrl: vi.fn<(file: File | Blob) => string>(() => 'blob:test'),
  loadImageElement: vi
    .fn<(url: string) => Promise<HTMLImageElement>>()
    .mockRejectedValue(new Error('TGS is not a native image')),
}));

const createTgsItem = (): TUploadItem => {
  const file = new File(['tgs'], 'sticker.tgs', { type: TGS_MIMETYPE });
  return {
    file,
    originalFile: file,
    encInfo: undefined,
    metadata: { markedAsSpoiler: false },
  };
};

describe('TGS message content', () => {
  it('sends TGS uploads as images with their MIME metadata', async () => {
    const content = await getImageMsgContent({} as MatrixClient, createTgsItem(), 'mxc://sticker');

    expect(content).toMatchObject({
      msgtype: MsgType.Image,
      body: 'sticker.tgs',
      url: 'mxc://sticker',
      info: {
        mimetype: TGS_MIMETYPE,
        size: 3,
      },
    });
  });

  it('classifies TGS gallery uploads as images', async () => {
    const content = await getGalleryItemContent(
      {} as MatrixClient,
      createTgsItem(),
      'mxc://sticker'
    );

    expect(content.itemtype).toBe(MsgType.Image);
  });
});
