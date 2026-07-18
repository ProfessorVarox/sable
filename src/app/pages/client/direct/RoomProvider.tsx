import type { ReactNode } from 'react';
import { Spinner } from 'folds';
import { useParams } from 'react-router-dom';
import { useResolvedSelectedRoom } from '$hooks/router/useResolvedRoomId';
import { IsDirectRoomProvider, RoomProvider } from '$hooks/useRoom';
import { useMatrixClient } from '$hooks/useMatrixClient';
import { JoinBeforeNavigate } from '$features/join-before-navigate';
import { useDirectRooms } from './useDirectRooms';

export function DirectRouteRoomProvider({ children }: { children: ReactNode }) {
  const mx = useMatrixClient();
  const rooms = useDirectRooms();

  const { roomIdOrAlias: encodedRoomIdOrAlias, eventId: encodedEventId } = useParams();
  const roomIdOrAlias = encodedRoomIdOrAlias && decodeURIComponent(encodedRoomIdOrAlias);
  const eventId = encodedEventId && decodeURIComponent(encodedEventId);
  const { roomId, resolving } = useResolvedSelectedRoom();
  const room = mx.getRoom(roomId);

  if (resolving) return <Spinner variant="Secondary" size="600" />;

  if (!room || !rooms.includes(room.roomId)) {
    return <JoinBeforeNavigate roomIdOrAlias={roomIdOrAlias!} eventId={eventId} />;
  }

  return (
    <RoomProvider key={room.roomId} value={room}>
      <IsDirectRoomProvider value>{children}</IsDirectRoomProvider>
    </RoomProvider>
  );
}
