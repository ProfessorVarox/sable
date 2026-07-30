import type { TouchEventHandler } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatrixEvent, Relations, Room } from '$types/matrix-sdk';

vi.mock('$hooks/useMatrixClient', () => ({
  useMatrixClient: () => ({
    getUserId: () => '@me:example.com',
  }),
}));

vi.mock('$hooks/useMediaAuthentication', () => ({
  useMediaAuthentication: () => false,
}));

vi.mock('$utils/androidBack', () => ({
  useDismissOnBack: vi.fn<() => void>(),
}));

vi.mock('$components/emoji-board', () => ({
  EmojiBoard: () => null,
}));

vi.mock('$features/room/reaction-viewer', () => ({
  ReactionViewer: () => null,
}));

import { Reactions } from './Reactions';

afterEach(() => {
  cleanup();
});

const reactionEvent = {
  getSender: () => '@alice:example.com',
  getContent: () => ({}),
  getRelation: () => ({}),
} as unknown as MatrixEvent;

const relations = {
  getSortedAnnotationsByKey: () => [['👍', new Set([reactionEvent])]],
  on: () => undefined,
  removeListener: () => undefined,
} as unknown as Relations;

const room = {
  roomId: '!room:example.com',
  getMember: () => undefined,
} as unknown as Room;

function renderReactions(onTouchStart: TouchEventHandler<HTMLDivElement>) {
  return render(
    <div onTouchStart={onTouchStart}>
      <Reactions
        room={room}
        mEventId="$event:example.com"
        canSendReaction={false}
        canDeleteOwn={false}
        relations={relations}
        onReactionToggle={() => undefined}
      />
    </div>
  );
}

describe('Reactions touch handling', () => {
  it('does not let touchstart on a reaction chip reach the parent Message handler', () => {
    const onParentTouchStart = vi.fn<() => void>();
    const { container } = renderReactions(onParentTouchStart);

    const chip = container.querySelector('[data-reaction-key]');
    if (!chip) throw new Error('reaction chip not rendered');
    fireEvent.touchStart(chip);

    expect(onParentTouchStart).not.toHaveBeenCalled();
  });

  it('still lets touchstart on the reactions container bubble to the parent', () => {
    const onParentTouchStart = vi.fn<() => void>();
    const { container } = renderReactions(onParentTouchStart);

    const chip = container.querySelector('[data-reaction-key]');
    if (!chip || !chip.parentElement) throw new Error('reaction chip not rendered');
    fireEvent.touchStart(chip.parentElement);

    expect(onParentTouchStart).toHaveBeenCalledTimes(1);
  });
});
