import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { M_POLL_RESPONSE } from 'matrix-js-sdk';
import type { EventTimeline, EventTimelineSet, MatrixEvent } from '$types/matrix-sdk';
import { EventType, RelationType } from '$types/matrix-sdk';
import type { ResolvedHiddenEventSettings } from '$state/hooks/settings';
import type { ProcessedEvent } from './useProcessedTimeline';
import {
  getProcessedRowIndexForRawTimelineIndex,
  useProcessedTimeline,
} from './useProcessedTimeline';
import { M_POLL_START } from 'matrix-js-sdk';

const MY_USER = '@alice:test';
const OTHER_USER = '@bob:test';

const hiddenEvents: ResolvedHiddenEventSettings = {
  showHiddenEvents: false,
  showTombstoneEvents: false,
  hiddenEventEdits: false,
  hiddenEventRedactionTimeline: false,
  hiddenEventReactions: false,
  hiddenEventReactionTombstone: false,
  hiddenEventReactionRedactionTimeline: false,
  hiddenEventOther: false,
};

type FakeEventOptions = {
  id: string;
  type?: string;
  sender?: string;
  content?: Record<string, unknown>;
  prevContent?: Record<string, unknown>;
  relation?: { rel_type: string; event_id: string; key?: string };
  threadRootId?: string;
  ts?: number;
  isRedaction?: boolean;
};

function createEvent({
  id,
  type = EventType.RoomMessage as string,
  sender = OTHER_USER,
  content = { msgtype: 'm.text', body: 'hello' },
  prevContent = {},
  relation,
  threadRootId,
  ts = 1_000_000,
  isRedaction = false,
}: FakeEventOptions): MatrixEvent {
  return {
    getId: () => id,
    getType: () => type,
    getSender: () => sender,
    getContent: () => content,
    getPrevContent: () => prevContent,
    getWireContent: () => content,
    getTs: () => ts,
    isRedacted: () => false,
    isRedaction: () => isRedaction,
    isEncrypted: () => false,
    getRelation: () => relation ?? null,
    threadRootId,
  } as unknown as MatrixEvent;
}

function createReaction(id: string, targetId: string): MatrixEvent {
  const relation = { rel_type: RelationType.Annotation, event_id: targetId, key: '👍' };
  return createEvent({
    id,
    type: EventType.Reaction,
    content: { 'm.relates_to': relation },
    relation,
  });
}

function createEdit(id: string, targetId: string): MatrixEvent {
  const relation = { rel_type: RelationType.Replace, event_id: targetId };
  return createEvent({
    id,
    content: {
      msgtype: 'm.text',
      body: '* edited',
      'm.new_content': { msgtype: 'm.text', body: 'edited' },
      'm.relates_to': relation,
    },
    relation,
  });
}

function createThreadReply(id: string, rootId: string): MatrixEvent {
  const relation = { rel_type: RelationType.Thread, event_id: rootId };
  return createEvent({
    id,
    content: { msgtype: 'm.text', body: 'thread reply', 'm.relates_to': relation },
    relation,
    threadRootId: rootId,
  });
}

function createPollResponse(id: string, pollStartId: string): MatrixEvent {
  const relation = { rel_type: RelationType.Reference, event_id: pollStartId };
  return createEvent({
    id,
    type: M_POLL_RESPONSE.name,
    content: { 'm.relates_to': relation },
    relation,
  });
}

function createRedaction(id: string, targetId: string): MatrixEvent {
  return createEvent({
    id,
    type: EventType.RoomRedaction,
    content: { redacts: targetId },
    isRedaction: true,
  });
}

function createMembership(id: string): MatrixEvent {
  return createEvent({
    id,
    type: EventType.RoomMember,
    content: { membership: 'join' },
  });
}

function createTimeline(events: MatrixEvent[]): EventTimeline {
  const timelineSet = {
    relations: {
      getChildEventsForEvent: () => null,
    },
  } as unknown as EventTimelineSet;
  return {
    getEvents: () => events,
    getTimelineSet: () => timelineSet,
  } as unknown as EventTimeline;
}

function processTimeline(
  events: MatrixEvent[],
  readUptoEventId: string | undefined
): ProcessedEvent[] {
  const { result } = renderHook(() =>
    useProcessedTimeline({
      items: events.map((_, i) => i),
      linkedTimelines: [createTimeline(events)],
      ignoredUsersSet: new Set(),
      hiddenEvents,
      mxUserId: MY_USER,
      readUptoEventId,
      hideMembershipEvents: true,
      hideNickAvatarEvents: true,
      isReadOnly: false,
      hideMemberInReadOnly: false,
    })
  );
  return result.current;
}

const renderedIds = (processed: ProcessedEvent[]) => processed.map((e) => e.id);
const dividerIds = (processed: ProcessedEvent[]) =>
  processed.filter((e) => e.willRenderNewDivider).map((e) => e.id);

describe('useProcessedTimeline new-messages divider', () => {
  it('keeps poll start events with default hidden-event settings', () => {
    const processed = processTimeline(
      [
        createEvent({
          id: '$poll',
          type: M_POLL_START.name,
          content: { 'm.poll.start': {} },
        }),
      ],
      undefined
    );

    expect(renderedIds(processed)).toEqual(['$poll']);
  });

  it('processes append-only messages without rebuilding existing rows', () => {
    const events = [
      createEvent({ id: '$a', ts: 1_000_000 }),
      createEvent({ id: '$b', ts: 1_000_500 }),
    ];
    const timeline = createTimeline(events);
    const ignoredUsersSet = new Set<string>();
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) =>
        useProcessedTimeline({
          items: Array.from({ length: count }, (_, index) => index),
          linkedTimelines: [timeline],
          ignoredUsersSet,
          hiddenEvents,
          mxUserId: MY_USER,
          readUptoEventId: undefined,
          hideMembershipEvents: true,
          hideNickAvatarEvents: true,
          isReadOnly: false,
          hideMemberInReadOnly: false,
        }),
      { initialProps: { count: events.length } }
    );
    const existingRows = [...result.current];

    events.push(createEvent({ id: '$c', ts: 1_001_000 }));
    rerender({ count: events.length });

    expect(result.current.slice(0, 2)).toEqual(existingRows);
    expect(result.current[0]).toBe(existingRows[0]);
    expect(result.current[1]).toBe(existingRows[1]);
    expect(result.current[2]).toMatchObject({ id: '$c', collapsed: true });
  });

  it('rebuilds rows when an event lands mid-prefix instead of being appended', () => {
    const events = [
      createEvent({ id: '$a', ts: 1_000_000 }),
      createEvent({ id: '$b', ts: 1_000_500 }),
      createEvent({ id: '$c', ts: 1_001_000 }),
    ];
    const timeline = createTimeline(events);
    const ignoredUsersSet = new Set<string>();
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) =>
        useProcessedTimeline({
          items: Array.from({ length: count }, (_, index) => index),
          linkedTimelines: [timeline],
          ignoredUsersSet,
          hiddenEvents,
          mxUserId: MY_USER,
          readUptoEventId: undefined,
          hideMembershipEvents: true,
          hideNickAvatarEvents: true,
          isReadOnly: false,
          hideMemberInReadOnly: false,
        }),
      { initialProps: { count: events.length } }
    );

    // Both anchors — the first event and the one at the old last index — survive,
    // so only a full prefix check can tell this from an append.
    events.splice(1, 1, createEvent({ id: '$mid', ts: 1_000_200 }));
    events.push(createEvent({ id: '$d', ts: 1_001_500 }));
    rerender({ count: events.length });

    expect(renderedIds(result.current)).toEqual(['$a', '$mid', '$c', '$d']);
    expect(result.current.map((e) => e.itemIndex)).toEqual([0, 1, 2, 3]);
  });

  it('rebuilds relation state when an appended event can change an existing row', () => {
    const events = [createEvent({ id: '$a' }), createEvent({ id: '$b' })];
    const timeline = createTimeline(events);
    const ignoredUsersSet = new Set<string>();
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) =>
        useProcessedTimeline({
          items: Array.from({ length: count }, (_, index) => index),
          linkedTimelines: [timeline],
          ignoredUsersSet,
          hiddenEvents,
          mxUserId: MY_USER,
          readUptoEventId: undefined,
          hideMembershipEvents: true,
          hideNickAvatarEvents: true,
          isReadOnly: false,
          hideMemberInReadOnly: false,
        }),
      { initialProps: { count: events.length } }
    );
    const firstRow = result.current[0];

    events.push(createReaction('$reaction', '$a'));
    rerender({ count: events.length });

    expect(renderedIds(result.current)).toEqual(['$a', '$b']);
    expect(result.current[0]).not.toBe(firstRow);
  });

  it('preserves absolute event order across linked timelines', () => {
    const first = [createEvent({ id: '$a' }), createEvent({ id: '$b' })];
    const second = [createEvent({ id: '$c' }), createEvent({ id: '$d' })];
    const { result } = renderHook(() =>
      useProcessedTimeline({
        items: [0, 1, 2, 3],
        linkedTimelines: [createTimeline(first), createTimeline(second)],
        ignoredUsersSet: new Set(),
        hiddenEvents,
        mxUserId: MY_USER,
        readUptoEventId: undefined,
        hideMembershipEvents: true,
        hideNickAvatarEvents: true,
        isReadOnly: false,
        hideMemberInReadOnly: false,
      })
    );

    expect(renderedIds(result.current)).toEqual(['$a', '$b', '$c', '$d']);
  });

  it('renders exactly one divider after a receipt anchored on a rendered message', () => {
    const processed = processTimeline([createEvent({ id: '$a' }), createEvent({ id: '$b' })], '$a');

    expect(renderedIds(processed)).toEqual(['$a', '$b']);
    expect(dividerIds(processed)).toEqual(['$b']);
  });

  it.each([
    ['reaction', () => createReaction('$anchor', '$a')],
    ['edit', () => createEdit('$anchor', '$a')],
    ['thread reply', () => createThreadReply('$anchor', '$a')],
    ['hidden membership event', () => createMembership('$anchor')],
  ])('renders the divider when the receipt is anchored on a filtered %s', (_kind, anchor) => {
    const processed = processTimeline(
      [createEvent({ id: '$a' }), anchor(), createEvent({ id: '$b' })],
      '$anchor'
    );

    expect(renderedIds(processed)).toEqual(['$a', '$b']);
    expect(dividerIds(processed)).toEqual(['$b']);
  });

  it('keeps the divider pending across consecutive filtered events', () => {
    const processed = processTimeline(
      [
        createEvent({ id: '$a' }),
        createReaction('$r', '$a'),
        createEdit('$e', '$a'),
        createEvent({ id: '$b' }),
      ],
      '$r'
    );

    expect(renderedIds(processed)).toEqual(['$a', '$b']);
    expect(dividerIds(processed)).toEqual(['$b']);
  });

  it('keeps the divider pending when a filtered event follows a rendered receipt', () => {
    const processed = processTimeline(
      [createEvent({ id: '$a' }), createReaction('$r', '$a'), createEvent({ id: '$b' })],
      '$a'
    );

    expect(renderedIds(processed)).toEqual(['$a', '$b']);
    expect(dividerIds(processed)).toEqual(['$b']);
  });

  it('skips own messages when placing the divider after a filtered anchor', () => {
    const processed = processTimeline(
      [
        createEvent({ id: '$a' }),
        createReaction('$r', '$a'),
        createEvent({ id: '$mine', sender: MY_USER }),
        createEvent({ id: '$b' }),
      ],
      '$r'
    );

    expect(renderedIds(processed)).toEqual(['$a', '$mine', '$b']);
    expect(dividerIds(processed)).toEqual(['$b']);
  });

  it('renders no divider when the receipt is on the newest event', () => {
    const processed = processTimeline(
      [createEvent({ id: '$a' }), createEvent({ id: '$b' }), createReaction('$r', '$b')],
      '$r'
    );

    expect(dividerIds(processed)).toEqual([]);
  });

  it('renders no divider when the receipt event is not in the timeline', () => {
    const processed = processTimeline(
      [createEvent({ id: '$a' }), createEvent({ id: '$b' })],
      '$elsewhere'
    );

    expect(dividerIds(processed)).toEqual([]);
  });

  it('renders no divider without a read receipt', () => {
    const processed = processTimeline(
      [createEvent({ id: '$a' }), createEvent({ id: '$b' })],
      undefined
    );

    expect(dividerIds(processed)).toEqual([]);
  });
});

describe('useProcessedTimeline append-only fast path', () => {
  function appendToTimeline(initial: MatrixEvent[], appended: MatrixEvent) {
    const events = [...initial];
    const timeline = createTimeline(events);
    const ignoredUsersSet = new Set<string>();
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) =>
        useProcessedTimeline({
          items: Array.from({ length: count }, (_, index) => index),
          linkedTimelines: [timeline],
          ignoredUsersSet,
          hiddenEvents,
          mxUserId: MY_USER,
          readUptoEventId: undefined,
          hideMembershipEvents: true,
          hideNickAvatarEvents: true,
          isReadOnly: false,
          hideMemberInReadOnly: false,
        }),
      { initialProps: { count: events.length } }
    );
    const before = [...result.current];

    events.push(appended);
    rerender({ count: events.length });

    return { before, after: result.current };
  }

  // Every relation type can retarget an event already in the cached prefix.
  it.each([
    ['an edit', () => createEdit('$new', '$a')],
    ['a reaction', () => createReaction('$new', '$a')],
    ['a thread reply', () => createThreadReply('$new', '$a')],
    ['a poll response', () => createPollResponse('$new', '$a')],
    ['a redaction', () => createRedaction('$new', '$a')],
  ])('reprocesses the cached prefix when %s arrives', (_label, makeEvent) => {
    const { before, after } = appendToTimeline(
      [createEvent({ id: '$a' }), createEvent({ id: '$b' })],
      makeEvent()
    );

    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it.each([
    ['a message', () => createEvent({ id: '$new', ts: 1_000_001 })],
    ['a membership change', () => createMembership('$new')],
    ['a sticker', () => createEvent({ id: '$new', type: EventType.Sticker, ts: 1_000_001 })],
    [
      'a room name change',
      () => createEvent({ id: '$new', type: EventType.RoomName, ts: 1_000_001 }),
    ],
  ])('reuses the cached prefix when %s arrives', (_label, makeEvent) => {
    const { before, after } = appendToTimeline(
      [createEvent({ id: '$a' }), createEvent({ id: '$b' })],
      makeEvent()
    );

    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });
});

describe('getProcessedRowIndexForRawTimelineIndex', () => {
  it('finds the nearest preceding visible row in one pass', () => {
    const processed = processTimeline(
      [createEvent({ id: '$a' }), createReaction('$hidden', '$a'), createEvent({ id: '$b' })],
      undefined
    );

    expect(getProcessedRowIndexForRawTimelineIndex(processed, 1)).toEqual({
      rowIndex: 0,
      focusRawIndex: 0,
    });
    expect(getProcessedRowIndexForRawTimelineIndex(processed, 2)).toEqual({
      rowIndex: 1,
      focusRawIndex: 2,
    });
  });
});
