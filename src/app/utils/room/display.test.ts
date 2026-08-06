import { describe, expect, it } from 'vitest';
import type { MatrixClient, Room, RoomMember } from '$types/matrix-sdk';
import { getDmOtherMember } from './display';

const makeMember = (userId: string, membership: 'join' | 'invite'): RoomMember =>
  ({ userId, membership }) as RoomMember;

describe('getDmOtherMember', () => {
  it('resolves an invited direct-chat participant from m.direct', () => {
    const invitedMember = makeMember('@alice:example.org', 'invite');
    const room = {
      getMember: (userId: string) => (userId === invitedMember.userId ? invitedMember : undefined),
      getAvatarFallbackMember: () => undefined,
      roomId: '!dm:example.org',
    } as unknown as Room;
    const mx = {
      getAccountData: () => ({ getContent: () => ({ '@alice:example.org': [room.roomId] }) }),
      getUserId: () => '@me:example.org',
    } as unknown as MatrixClient;

    expect(getDmOtherMember(mx, room)).toBe(invitedMember);
  });

  it('uses the m.direct counterpart even when a bridge bot is also in the room', () => {
    const counterpart = makeMember('@alice:example.org', 'join');
    const room = {
      getMember: (userId: string) => (userId === counterpart.userId ? counterpart : undefined),
      getAvatarFallbackMember: () => makeMember('@bridgebot:example.org', 'join'),
      roomId: '!dm:example.org',
    } as unknown as Room;
    const mx = {
      getAccountData: () => ({ getContent: () => ({ '@alice:example.org': [room.roomId] }) }),
      getUserId: () => '@me:example.org',
    } as unknown as MatrixClient;

    expect(getDmOtherMember(mx, room)).toBe(counterpart);
  });
});
