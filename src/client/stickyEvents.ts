import type { Extension, IRoomEvent, MatrixClient, MatrixEvent, Room } from '$types/matrix-sdk';
import { ExtensionState, RoomEvent, UNSTABLE_MSC4354_STICKY_EVENTS } from '$types/matrix-sdk';
import { createDebugLogger } from '$utils/debugLogger';

const debugLog = createDebugLogger('slidingSync');

const STICKY_EVENTS_EXTENSION = 'org.matrix.msc4354.sticky_events';
const STICKY_EVENTS_LIMIT = 100;

type StickyEventsRequest = {
  enabled: boolean;
  limit?: number;
  since?: string;
};

type StickyEventsResponse = {
  next_batch?: string;
  rooms?: Record<string, { events?: IRoomEvent[] }>;
};

const isSticky = (event: MatrixEvent): boolean => event.unstableStickyInfo !== undefined;

const rejectKnownStickyEvents = (room: Room, events: MatrixEvent[]): MatrixEvent[] => {
  const known = new Set<string>();
  for (const event of room._unstable_getStickyEvents()) {
    const eventId = event.getId();
    if (eventId) known.add(eventId);
  }
  return events.filter((event) => {
    const eventId = event.getId();
    return !eventId || !known.has(eventId);
  });
};

export const addStickyEvents = (room: Room, events: MatrixEvent[]): void => {
  const sticky = rejectKnownStickyEvents(room, events.filter(isSticky));
  if (sticky.length === 0) return;
  room._unstable_addStickyEvents(sticky);
};

export class StickyEventsExtension implements Extension<StickyEventsRequest, StickyEventsResponse> {
  private since: string | undefined;

  private serverSupport: Promise<boolean> | undefined;

  public constructor(private readonly mx: MatrixClient) {}

  public name(): string {
    return STICKY_EVENTS_EXTENSION;
  }

  public when(): ExtensionState {
    return ExtensionState.PostProcess;
  }

  private supported(): Promise<boolean> {
    this.serverSupport ??= this.mx
      .doesServerSupportUnstableFeature(UNSTABLE_MSC4354_STICKY_EVENTS)
      .catch(() => false);
    return this.serverSupport;
  }

  public async onRequest(isInitial: boolean): Promise<StickyEventsRequest> {
    if (isInitial) this.since = undefined;
    if (!(await this.supported())) return { enabled: false };
    return {
      enabled: true,
      limit: STICKY_EVENTS_LIMIT,
      ...(this.since ? { since: this.since } : {}),
    };
  }

  public async onResponse(data: StickyEventsResponse): Promise<void> {
    if (!data) return;
    if (data.next_batch) this.since = data.next_batch;

    const mapper = this.mx.getEventMapper();
    for (const [roomId, roomData] of Object.entries(data.rooms ?? {})) {
      const room = this.mx.getRoom(roomId);
      if (!room) {
        debugLog.warn('sync', `sticky events for unknown room ${roomId}`);
        continue;
      }
      const events = (roomData.events ?? []).map((event) => mapper({ ...event, room_id: roomId }));
      addStickyEvents(room, events);
    }
  }
}

export const forwardTimelineStickyEvents = (mx: MatrixClient): (() => void) => {
  const onTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined
  ) => {
    if (!room || toStartOfTimeline || !isSticky(event)) return;
    addStickyEvents(room, [event]);
  };

  mx.on(RoomEvent.Timeline, onTimeline);
  return () => mx.removeListener(RoomEvent.Timeline, onTimeline);
};
