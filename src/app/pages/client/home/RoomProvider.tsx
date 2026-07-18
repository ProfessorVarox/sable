import type { ReactNode } from 'react';
import { Spinner } from 'folds';
import { useParams } from 'react-router-dom';
import { useResolvedSelectedRoom } from '$hooks/router/useResolvedRoomId';
import { IsDirectRoomProvider, RoomProvider } from '$hooks/useRoom';
import { useMatrixClient } from '$hooks/useMatrixClient';
import { JoinBeforeNavigate } from '$features/join-before-navigate';
import { useSearchParamsViaServers } from '$hooks/router/useSearchParamsViaServers';
import { useHomeRooms } from './useHomeRooms';
import { useSetting } from '$state/hooks/settings';
import { settingsAtom } from '$state/settings';

export function HomeRouteRoomProvider({ children }: { children: ReactNode }) {
  const mx = useMatrixClient();
  const [isShowingAllRoomsInHome] = useSetting(settingsAtom, 'isShowingAllRoomsInHome');
  const rooms = useHomeRooms();

  const { roomIdOrAlias: encodedRoomIdOrAlias, eventId: encodedEventId } = useParams();
  const roomIdOrAlias = encodedRoomIdOrAlias && decodeURIComponent(encodedRoomIdOrAlias);
  const eventId = encodedEventId && decodeURIComponent(encodedEventId);
  const viaServers = useSearchParamsViaServers();
  const { roomId, resolving } = useResolvedSelectedRoom();
  const room = mx.getRoom(roomId);

  if (resolving) return <Spinner variant="Secondary" size="600" />;

  if (!room || (!isShowingAllRoomsInHome && !rooms.includes(room.roomId))) {
    return (
      <JoinBeforeNavigate
        roomIdOrAlias={roomIdOrAlias!}
        eventId={eventId}
        viaServers={viaServers}
      />
    );
  }

  return (
    <RoomProvider key={room.roomId} value={room}>
      <IsDirectRoomProvider value={false}>{children}</IsDirectRoomProvider>
    </RoomProvider>
  );
}
