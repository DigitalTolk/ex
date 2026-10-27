import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import type { UserUpdatedPayload } from '@/lib/ws-schemas';
import type { ChannelMembership, User, UserConversation, UserStatus } from '@/types';

// user.updated is published for a status set or cleared (and by the sweeper
// that clears expired ones), a time-zone change, a profile save, a directory
// sync and an (de)activation, each carrying only the fields it changed. It
// used to invalidate every user-shaped cache — the profile, every users
// batch (each refetching all its ids), the whole roster, searches, member
// lists and both sidebar lists — some 6-8 requests per client per event.
// The payload is patched into the cached copies instead; only a list whose
// rows the server derives from the user's name or avatar (a group
// conversation's title, a DM's avatar) is refetched, and only when one of
// those changed for a user it shows.

type UserPatch = Partial<Pick<User, 'displayName' | 'avatarURL' | 'userStatus' | 'timeZone' | 'lastSeenAt' | 'status' | 'phone' | 'manager'>>;

function userPatch(evt: UserUpdatedPayload): UserPatch {
  const patch: UserPatch = {};
  if (evt.displayName !== undefined) patch.displayName = evt.displayName;
  // An empty URL is "no avatar": the initials show.
  if (evt.avatarURL !== undefined) patch.avatarURL = evt.avatarURL || undefined;
  // Present-and-null is a cleared status; absent means unchanged.
  if (Object.prototype.hasOwnProperty.call(evt, 'userStatus')) {
    patch.userStatus = evt.userStatus == null ? undefined : (evt.userStatus as UserStatus);
  }
  if (evt.timeZone !== undefined) patch.timeZone = evt.timeZone;
  if (evt.lastSeenAt !== undefined) patch.lastSeenAt = evt.lastSeenAt;
  if (evt.status !== undefined) patch.status = evt.status;
  if (evt.phone !== undefined) patch.phone = evt.phone;
  if (evt.manager !== undefined) patch.manager = evt.manager ?? undefined;
  return patch;
}

// The same list back when the user is not in it, so its observers don't
// re-render for someone they don't show.
function patchRows<T extends { id: string }>(rows: T[] | undefined, id: string, patch: UserPatch): T[] | undefined {
  if (!Array.isArray(rows) || !rows.some((row) => row.id === id)) return rows;
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

const isDMWith = (conv: UserConversation, userID: string, selfID: string | undefined) =>
  conv.type === 'dm' && userID !== selfID && !!conv.participantIDs?.includes(userID);

export function applyUserUpdatedEvent(qc: QueryClient, evt: UserUpdatedPayload, selfID: string | undefined): void {
  const { id } = evt;
  const patch = userPatch(evt);

  qc.setQueryData<Partial<User>>(queryKeys.user(id), (user) => (user ? { ...user, ...patch } : user));
  for (const key of [queryKeys.usersBatch(), queryKeys.allUsers(), queryKeys.searchUsers(), queryKeys.usersDirectory()]) {
    qc.setQueriesData<User[]>({ queryKey: key }, (rows) => patchRows<User>(rows, id, patch));
  }

  // A deactivated account leaves every member list at once (the server
  // lists only active members); a reactivated one is back with the next read.
  if (patch.status === 'deactivated') {
    qc.setQueriesData<ChannelMembership[]>({ queryKey: queryKeys.channelMembers() }, (rows) =>
      Array.isArray(rows) && rows.some((m) => m.userID === id) ? rows.filter((m) => m.userID !== id) : rows,
    );
  } else if (patch.status !== undefined) {
    void qc.invalidateQueries({ queryKey: queryKeys.channelMembers() });
  }

  if (patch.displayName !== undefined) {
    const displayName = patch.displayName;
    qc.setQueriesData<ChannelMembership[]>({ queryKey: queryKeys.channelMembers() }, (rows) =>
      Array.isArray(rows) && rows.some((m) => m.userID === id)
        ? rows.map((m) => (m.userID === id ? { ...m, displayName } : m))
        : rows,
    );
  }

  const conversations = qc.getQueryData<UserConversation[]>(queryKeys.userConversations());
  if (!Array.isArray(conversations)) return;
  if (patch.displayName !== undefined || 'avatarURL' in patch) {
    // A DM's name and avatar, and a group's title, are put together by the
    // server from its participants' profiles.
    if (conversations.some((conv) => conv.participantIDs?.includes(id))) {
      void qc.invalidateQueries({ queryKey: queryKeys.userConversations() });
    }
    return;
  }
  if ('userStatus' in patch && conversations.some((conv) => isDMWith(conv, id, selfID))) {
    const userStatus = patch.userStatus;
    qc.setQueryData<UserConversation[]>(
      queryKeys.userConversations(),
      conversations.map((conv) => (isDMWith(conv, id, selfID) ? { ...conv, userStatus } : conv)),
    );
  }
}
