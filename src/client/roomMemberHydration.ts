import type { MatrixClient, Room } from '$types/matrix-sdk';
import { EventType, MatrixEvent } from '$types/matrix-sdk';

const inFlight = new WeakMap<MatrixClient, Map<string, Promise<void>>>();

export const hydrateRoomMember = (
  mx: MatrixClient,
  roomId: string,
  userId: string
): Promise<void> => {
  const room = mx.getRoom(roomId);
  if (!room || room.getMember(userId)) return Promise.resolve();

  const key = `${roomId}\u0000${userId}`;
  const pending = inFlight.get(mx) ?? new Map<string, Promise<void>>();
  inFlight.set(mx, pending);
  const existing = pending.get(key);
  if (existing) return existing;

  const request = mx
    .getStateEvent(roomId, EventType.RoomMember, userId)
    .then((content) => {
      const currentRoom = mx.getRoom(roomId);
      if (!currentRoom || currentRoom.getMember(userId)) return;
      currentRoom.currentState.setStateEvents([
        new MatrixEvent({
          type: EventType.RoomMember,
          state_key: userId,
          room_id: roomId,
          sender: userId,
          content,
        }),
      ]);
    })
    .catch(() => undefined)
    .finally(() => pending.delete(key));

  pending.set(key, request);
  return request;
};

export const hydrateRoomMembers = (
  mx: MatrixClient,
  roomId: string,
  userIds: Iterable<string>
): Promise<void[]> =>
  Promise.all(
    [...new Set(userIds)]
      .filter((userId) => userId.startsWith('@'))
      .map((userId) => hydrateRoomMember(mx, roomId, userId))
  );

export const getRoomMemberAvatarMxc = (room: Room, userId: string): string | undefined =>
  room.getMember(userId)?.getMxcAvatarUrl();
