import { forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Editor } from 'slate';
import type { Room } from '$types/matrix-sdk';
import type { ProcessedEvent } from '$hooks/timeline/useProcessedTimeline';
import type * as DomUtils from '$utils/dom';
import { RoomTimeline } from './RoomTimeline';

const { vListHandle, timelineSync, setUnreadTimelineMock } = vi.hoisted(() => ({
  vListHandle: {
    scrollSize: 1000,
    scrollOffset: 0,
    viewportSize: 600,
    scrollToIndex: vi.fn<() => void>(),
    scrollTo: vi.fn<() => void>(),
    getItemOffset: () => 0,
    getItemSize: () => 100,
  },
  timelineSync: {
    eventsLength: 1,
    timeline: { linkedTimelines: [] },
    liveTimelineLinked: true,
    backwardStatus: 'idle',
    forwardStatus: 'idle',
    canPaginateBack: false,
    focusItem: undefined,
    setFocusItem: vi.fn<() => void>(),
    setTimeline: vi.fn<() => void>(),
    loadEventTimeline: vi.fn<() => void>(),
    handleTimelinePagination: vi.fn<() => void>(),
  },
  setUnreadTimelineMock: vi.fn<() => void>(),
}));

let lastOnScroll: ((offset: number) => void) | undefined;

vi.mock('virtua', () => ({
  VList: forwardRef(function MockVList(
    {
      data,
      children,
      onScroll,
    }: {
      data: unknown[];
      children: (item: unknown, index: number) => ReactNode;
      onScroll?: (offset: number) => void;
    },
    ref
  ) {
    lastOnScroll = onScroll;
    useImperativeHandle(ref, () => vListHandle);
    return (
      // Outer element is the VList scroll container (messageListRef's first
      // child); inner element is the content element the fix observes.
      <div data-testid="vlist-scroll">
        <div data-testid="vlist-content">{data.map((item, index) => children(item, index))}</div>
      </div>
    );
  }),
}));

vi.mock('$hooks/useMatrixClient', () => ({
  useMatrixClient: () => ({
    getUserId: () => '@me:example.org',
    pushProcessor: undefined,
  }),
}));

vi.mock('$hooks/useAlive', () => ({ useAlive: () => true }));

vi.mock('$hooks/useRoom', () => ({ useIsInactivePanel: () => false }));

vi.mock('$hooks/useSlidingSyncActiveRoom', () => ({
  useSlidingSyncRoomLoading: () => false,
}));

vi.mock('$hooks/useMessageEdit', () => ({
  useMessageEdit: () => ({ editId: undefined, handleEdit: vi.fn<() => void>() }),
}));

vi.mock('$hooks/useRoomNavigate', () => ({
  useRoomNavigate: () => ({ navigateRoom: vi.fn<() => void>() }),
}));

vi.mock('$hooks/useSpace', () => ({ useSpaceOptionally: () => undefined }));

vi.mock('$hooks/useIgnoredUsers', () => ({ useIgnoredUsers: () => [] }));

vi.mock('$hooks/useImagePackRooms', () => ({ useImagePackRooms: () => [] }));

vi.mock('$state/hooks/userRoomProfile', () => ({
  useOpenUserRoomProfile: () => vi.fn<() => void>(),
}));

vi.mock('$hooks/timeline/useTimelineSync', () => ({
  useTimelineSync: () => ({
    ...timelineSync,
    setUnreadInfo: setUnreadTimelineMock,
  }),
}));

vi.mock('$hooks/timeline/useTimelineActions', () => ({
  useTimelineActions: () => ({
    handleUserClick: vi.fn<() => void>(),
    handleUsernameClick: vi.fn<() => void>(),
    handleReplyClick: vi.fn<() => void>(),
    handleReactionToggle: vi.fn<() => void>(),
    handleEdit: vi.fn<() => void>(),
    handleResend: vi.fn<() => void>(),
    handleDeleteFailedSend: vi.fn<() => void>(),
    handleOpenReply: vi.fn<() => void>(),
    setOpenThread: vi.fn<() => void>(),
  }),
}));

vi.mock('$hooks/timeline/useProcessedTimeline', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fakeEvent: ProcessedEvent = {
    id: '$evt1',
    itemIndex: 0,
    collapsed: false,
    willRenderNewDivider: false,
    willRenderDayDivider: false,
    mEvent: {
      getType: () => 'm.room.message',
      getStateKey: () => undefined,
      getTs: () => Date.now(),
      getSender: () => '@me:example.org',
      getId: () => '$evt1',
      isRedacted: () => false,
    },
    timelineSet: undefined,
    eventSender: '@me:example.org',
    editId: undefined,
    reactionsKey: '',
    content: undefined,
  } as unknown as ProcessedEvent;
  return {
    ...actual,
    useProcessedTimeline: () => [fakeEvent],
  };
});

vi.mock('$hooks/timeline/useTimelineEventRenderer', () => ({
  useTimelineEventRenderer: () => () => null,
}));

vi.mock('$hooks/timeline/useTimelineRendererContext', () => ({
  useTimelineRendererContext: () => ({
    settings: {
      hiddenEvents: {},
      messageLayout: 0,
      messageSpacing: '300',
      hideReads: false,
      hideMembershipEvents: false,
      hideNickAvatarEvents: false,
      hideMemberInReadOnly: false,
    },
    linkifyOpts: {},
    htmlReactParserOptions: {},
    permissions: {
      canRedact: false,
      canDeleteOwn: false,
      canSendReaction: false,
      canPinEvent: false,
      isReadOnly: false,
      getMemberPowerTag: vi.fn<() => void>(),
      parseMemberEvent: vi.fn<() => void>(),
    },
  }),
}));

vi.mock('$components/room-intro', () => ({ RoomIntro: () => null }));

vi.mock('$utils/timeline', () => ({
  getRoomUnreadInfo: () => undefined,
  getEventTimeline: () => undefined,
  getFirstLinkedTimeline: () => undefined,
  getInitialTimeline: () => undefined,
  getEventIdAbsoluteIndex: () => undefined,
}));

vi.mock('$utils/notifications', () => ({ markAsRead: vi.fn<() => void>() }));

vi.mock('$utils/dom', async (importOriginal) => {
  const actual = await importOriginal<typeof DomUtils>();
  return { ...actual, isWindowFocused: () => false };
});

type ObserverEntry = { callback: ResizeObserverCallback; elements: Set<Element> };

const observers: ObserverEntry[] = [];

function ResizeObserverStub(this: unknown, callback: ResizeObserverCallback) {
  const entry: ObserverEntry = { callback, elements: new Set() };
  observers.push(entry);
  return {
    observe: (el: Element) => entry.elements.add(el),
    unobserve: (el: Element) => entry.elements.delete(el),
    disconnect: () => entry.elements.clear(),
  };
}

const nativeResizeObserver = globalThis.ResizeObserver;

const fireResize = (element: Element) => {
  observers.forEach(({ callback, elements }) => {
    if (!elements.has(element)) return;
    callback(
      [{ target: element, contentRect: { height: 1 } } as unknown as ResizeObserverEntry],
      {} as ResizeObserver
    );
  });
};

const room = {
  roomId: '!room:example.org',
  getLiveTimeline: () => undefined,
} as unknown as Room;

const getContentEl = (container: HTMLElement) => {
  const contentEl = container.querySelector('[data-testid="vlist-content"]');
  expect(contentEl).toBeTruthy();
  return contentEl as Element;
};

const renderTimeline = () => render(<RoomTimeline room={room} editor={{} as Editor} />);

describe('RoomTimeline content ResizeObserver', () => {
  beforeEach(() => {
    observers.length = 0;
    lastOnScroll = undefined;
    vListHandle.scrollSize = 1000;
    vListHandle.scrollOffset = 0;
    vListHandle.viewportSize = 600;
    vListHandle.scrollToIndex.mockReset();
    vListHandle.scrollTo.mockReset();
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = nativeResizeObserver;
  });

  it('re-pins to the bottom when the VList content grows while pinned and live', async () => {
    const { container } = renderTimeline();

    // Let the mount-time initial scroll and its 80ms timer settle, then
    // isolate the content-resize behavior.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    vListHandle.scrollToIndex.mockClear();

    const contentEl = getContentEl(container);
    act(() => fireResize(contentEl));

    expect(vListHandle.scrollToIndex).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ align: 'end' })
    );
  });

  it('does not re-pin on content growth after scrolling off the bottom', async () => {
    const { container } = renderTimeline();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    // Scroll far off the bottom: scrollSize - offset - viewportSize >= 100.
    act(() => lastOnScroll?.(0));
    vListHandle.scrollToIndex.mockClear();

    const contentEl = getContentEl(container);
    act(() => fireResize(contentEl));

    expect(vListHandle.scrollToIndex).not.toHaveBeenCalled();
  });
});
