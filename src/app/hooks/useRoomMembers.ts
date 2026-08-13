import type { MatrixClient, MatrixEvent, RoomMember } from '$types/matrix-sdk';
import { RoomMemberEvent } from '$types/matrix-sdk';
import { useEffect, useState } from 'react';
import { hydrateAllRoomMembers } from '$client/roomMemberHydration';

export const useRoomMembers = (mx: MatrixClient, roomId: string, enabled = true): RoomMember[] => {
  const [members, setMembers] = useState<RoomMember[]>([]);

  useEffect(() => {
    if (!enabled) {
      setMembers([]);
      return undefined;
    }

    const room = mx.getRoom(roomId);
    let disposed = false;

    const updateMemberList = (event?: MatrixEvent) => {
      if (!room || disposed || (event && event.getRoomId() !== roomId)) return;
      setMembers(room.getMembers());
    };

    if (room) {
      setMembers(room.getMembers());
      // Sliding sync may retain an incomplete member set. Do not let its SDK
      // request block incoming membership updates. A failed request must not
      // trigger the direct roster fallback: classic sync already owns retries.
      void room.loadMembersIfNeeded().then(
        () => {
          updateMemberList();
          void hydrateAllRoomMembers(mx, roomId).then(() => updateMemberList());
        },
        () => updateMemberList()
      );
    }

    mx.on(RoomMemberEvent.Membership, updateMemberList);
    mx.on(RoomMemberEvent.PowerLevel, updateMemberList);
    return () => {
      disposed = true;
      mx.removeListener(RoomMemberEvent.Membership, updateMemberList);
      mx.removeListener(RoomMemberEvent.PowerLevel, updateMemberList);
    };
  }, [enabled, mx, roomId]);

  return members;
};
