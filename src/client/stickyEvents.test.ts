import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from '$types/matrix-sdk';
import { MatrixEvent, RoomEvent } from '$types/matrix-sdk';
import { forwardTimelineStickyEvents, StickyEventsExtension } from './stickyEvents';

const roomId = '!room:example.com';
const userId = '@user:example.com';

const eventJson = (eventId: string, sticky = true) => ({
  type: 'm.rtc.member',
  event_id: eventId,
  sender: userId,
  origin_server_ts: Date.now(),
  content: { msc4354_sticky_key: `${userId}:DEVICE` },
  ...(sticky ? { msc4354_sticky: { duration_ms: 60_000 } } : {}),
});

const makeRoom = (existing: MatrixEvent[] = []) => {
  const added: MatrixEvent[][] = [];
  const room = {
    roomId,
    _unstable_getStickyEvents: () => existing,
    _unstable_addStickyEvents: (events: MatrixEvent[]) => added.push(events),
  } as unknown as Room;
  return { room, added };
};

const makeClient = (room: Room | undefined, supported = true) =>
  ({
    getRoom: () => room,
    getEventMapper: () => (event: Record<string, unknown>) => new MatrixEvent(event),
    doesServerSupportUnstableFeature: vi.fn<() => Promise<boolean>>().mockResolvedValue(supported),
  }) as unknown as MatrixClient;

describe('StickyEventsExtension', () => {
  it('stays disabled when the server does not support MSC4354', async () => {
    const extension = new StickyEventsExtension(makeClient(undefined, false));
    expect(await extension.onRequest(true)).toEqual({ enabled: false });
  });

  it('enables itself and threads the since token', async () => {
    const extension = new StickyEventsExtension(makeClient(makeRoom().room));

    expect(await extension.onRequest(true)).toEqual({ enabled: true, limit: 100 });

    await extension.onResponse({ next_batch: '42' });
    expect(await extension.onRequest(false)).toEqual({ enabled: true, limit: 100, since: '42' });

    expect(await extension.onRequest(true)).toEqual({ enabled: true, limit: 100 });
  });

  it('feeds sticky events into the room store', async () => {
    const { room, added } = makeRoom();
    const extension = new StickyEventsExtension(makeClient(room));

    await extension.onResponse({
      rooms: { [roomId]: { events: [eventJson('$one'), eventJson('$two')] } },
    });

    expect(added).toHaveLength(1);
    expect(added[0]?.map((event) => event.getId())).toEqual(['$one', '$two']);
    expect(added[0]?.[0]?.getRoomId()).toBe(roomId);
  });

  it('ignores events the server did not mark sticky', async () => {
    const { room, added } = makeRoom();
    const extension = new StickyEventsExtension(makeClient(room));

    await extension.onResponse({
      rooms: { [roomId]: { events: [eventJson('$plain', false)] } },
    });

    expect(added).toHaveLength(0);
  });

  it('does not re-add an event the store already holds', async () => {
    const known = new MatrixEvent(eventJson('$one'));
    const { room, added } = makeRoom([known]);
    const extension = new StickyEventsExtension(makeClient(room));

    await extension.onResponse({
      rooms: { [roomId]: { events: [eventJson('$one'), eventJson('$two')] } },
    });

    expect(added).toHaveLength(1);
    expect(added[0]?.map((event) => event.getId())).toEqual(['$two']);
  });
});

const makeEmitter = () => {
  const listeners = new Set<(...args: unknown[]) => void>();
  const mx = {
    on: (_event: string, listener: (...args: unknown[]) => void) => listeners.add(listener),
    removeListener: (_event: string, listener: (...args: unknown[]) => void) =>
      listeners.delete(listener),
  } as unknown as MatrixClient;
  const emit = (...args: unknown[]) => listeners.forEach((listener) => listener(...args));
  return { mx, emit, listeners };
};

describe('forwardTimelineStickyEvents', () => {
  it('forwards live sticky timeline events to the room store', () => {
    const { room, added } = makeRoom();
    const { mx, emit } = makeEmitter();
    forwardTimelineStickyEvents(mx);

    emit(new MatrixEvent(eventJson('$one')), room, false);

    expect(added).toHaveLength(1);
    expect(added[0]?.[0]?.getId()).toBe('$one');
  });

  it('ignores back-paginated and non-sticky events', () => {
    const { room, added } = makeRoom();
    const { mx, emit } = makeEmitter();
    forwardTimelineStickyEvents(mx);

    emit(new MatrixEvent(eventJson('$one')), room, true);
    emit(new MatrixEvent(eventJson('$two', false)), room, false);

    expect(added).toHaveLength(0);
  });

  it('stops forwarding once detached', () => {
    const { room, added } = makeRoom();
    const { mx, emit, listeners } = makeEmitter();
    const detach = forwardTimelineStickyEvents(mx);

    detach();
    expect(listeners.size).toBe(0);
    emit(new MatrixEvent(eventJson('$one')), room, false);

    expect(added).toHaveLength(0);
  });

  it('registers on the timeline event', () => {
    const on = vi.fn<(event: string, listener: () => void) => void>();
    const removeListener = vi.fn<(event: string, listener: () => void) => void>();
    forwardTimelineStickyEvents({ on, removeListener } as unknown as MatrixClient);
    expect(on).toHaveBeenCalledWith(RoomEvent.Timeline, expect.any(Function));
  });
});
