import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { markParentRead, type ReadParentKind } from '@/lib/mark-read';
import {
  countUnreadAfter,
  countUnreadFrom,
  findUnreadDivider,
  maxId,
  newestReadPointId,
} from '@/lib/unread-marker';
import {
  clearReadPosition,
  getAckedThrough,
  isListAtBottom,
  useListAtBottom,
  useReadThrough,
} from '@/stores/read-position';
import type { Message } from '@/types';

// What the open list renders for unread: the frozen "New" divider, the
// banner's count/"since", and the scrolled-up pill's count.
export interface UnreadMarkerState {
  // First unread message of this visit (frozen once known). The divider row
  // renders above it.
  dividerMsgId?: string;
  // The first unread is in an older page that isn't loaded yet — the banner
  // still shows (with the server's count) and Jump pages back to find it.
  pending: boolean;
  // Banner count: counted messages from the divider on (or the server's
  // unread count while pending).
  count: number;
  // createdAt of the first unread, for "since 3:07 PM".
  since?: string;
  // Pill count: messages that arrived after the local read point, i.e.
  // while scrolled up / away.
  newCount: number;
  // Persist a read up to the newest loaded message (Jump to latest, ✕/Esc).
  markRead: () => void;
}

interface Snapshot {
  parentID?: string;
  captured: boolean;
  watermark?: string;
  unreadCount: number;
}

interface UseUnreadMarkerArgs {
  kind: ReadParentKind;
  parentID: string | undefined;
  pages: { items: Message[] }[] | undefined;
  // The message query has settled (even if empty).
  messagesLoaded: boolean;
  // Older (hasNextPage) / newer (hasPreviousPage, deep-link window) pages
  // exist beyond the loaded slice.
  hasOlderPages: boolean;
  hasNewerPages: boolean;
  currentUserId?: string;
}

// useUnreadMarker owns the read lifecycle of an open channel/conversation
// (Slack/Discord model):
//
//  1. SNAPSHOT the server read point (lastReadMsgID + unreadCount) from the
//     sidebar list cache BEFORE anything marks the parent read — taken once
//     per open, during render, so no effect ordering can clear it first.
//  2. Place the "New" divider at the first counted message after it, and
//     FREEZE it for the visit (only once certain: the loaded window reaches
//     the read point). A frozen divider never moves, so rows never shift
//     under the reader.
//  3. PERSIST reads only when the user actually sees the latest message: on
//     open if the list is at the bottom, when they scroll back to the
//     bottom, and when they return to the window while at the bottom.
//     Scrolled up, nothing is persisted — the sidebar badge stays, and
//     messages arriving meanwhile get the divider + pill.
//
// Messages that arrive while the user is watching the tail are read by
// ChatPage's WS switchboard (it knows the attention state at arrival), which
// advances the same local read point, so this hook never double-PUTs them.
export function useUnreadMarker({
  kind,
  parentID,
  pages,
  messagesLoaded,
  hasOlderPages,
  hasNewerPages,
  currentUserId,
}: UseUnreadMarkerArgs): UnreadMarkerState {
  const queryClient = useQueryClient();
  const channels = useUserChannels({ enabled: kind === 'channel' });
  const conversations = useUserConversations({ enabled: kind === 'conversation' });
  const list = kind === 'channel' ? channels : conversations;
  const row = useMemo(() => {
    if (!parentID) return undefined;
    if (kind === 'channel') return channels.data?.find((c) => c.channelID === parentID);
    return conversations.data?.find((c) => c.conversationID === parentID);
  }, [kind, parentID, channels.data, conversations.data]);
  // The list has answered: the row either exists or never will (not a
  // member / not listed) — either way the snapshot can be taken.
  const listSettled = !!row || !list.isPending;

  // (1) Snapshot, re-taken whenever the parent changes. Set-during-render
  // (not an effect) so it's in place before any mark-read effect runs.
  const [snapshot, setSnapshot] = useState<Snapshot>({ captured: false, unreadCount: 0 });
  if (parentID && (snapshot.parentID !== parentID || (!snapshot.captured && listSettled))) {
    setSnapshot({
      parentID,
      captured: listSettled,
      watermark: row?.lastReadMsgID,
      unreadCount: row?.unreadCount ?? 0,
    });
  }
  const snap: Snapshot = snapshot.parentID === parentID ? snapshot : { captured: false, unreadCount: 0 };

  const messages = useMemo(() => (pages ?? []).flatMap((p) => p.items).slice().reverse(), [pages]);
  const readThrough = useReadThrough(parentID);
  const atBottom = useListAtBottom(parentID);

  // (2) Divider. Until the open-time unread is resolved, measure from the
  // snapshot (the local read point jumps ahead as soon as we mark read on
  // open, but the divider must still land where the user left off); after
  // that, from the local read point, so a message arriving while scrolled up
  // or away starts a divider if none is showing yet.
  //
  // `id` undefined with the record present = resolved, nothing unread.
  // `baseline` is the newest message loaded when it resolved: everything up to
  // it was on screen at open, so it can never become "new" later — even if
  // the cached server watermark lags (another device, a missed echo).
  const newestId = newestReadPointId(messages);
  const [divider, setDivider] = useState<{ parentID: string; id?: string; baseline?: string } | null>(null);
  const resolved = divider && divider.parentID === parentID ? divider : undefined;
  const initialPhase = snap.unreadCount > 0 && !resolved;
  const liveWatermark = maxId(maxId(snap.watermark, readThrough), resolved?.baseline);
  const candidate = useMemo(
    () =>
      findUnreadDivider({
        messages,
        currentUserId,
        watermark: initialPhase ? snap.watermark : liveWatermark,
        fallbackCount: initialPhase ? snap.unreadCount : 0,
        hasOlderPages,
      }),
    [messages, currentUserId, initialPhase, snap.watermark, snap.unreadCount, liveWatermark, hasOlderPages],
  );
  if (parentID && snap.captured && messagesLoaded) {
    if (!resolved && !initialPhase) {
      // Nothing unread at open: resolve now with the loaded tail as baseline.
      setDivider({ parentID, baseline: newestId });
    } else if (candidate.certain && (!resolved || (!resolved.id && candidate.id))) {
      setDivider({ parentID, id: candidate.id, baseline: resolved?.baseline ?? newestId });
    }
  }
  const dividerMsgId = resolved?.id ?? (initialPhase && candidate.certain ? candidate.id : undefined);
  const pending = snap.captured && initialPhase && !candidate.certain;

  // (3) Persist up to the newest loaded message, skipping a PUT the local read
  // point already covers. A deep-link window's newest loaded message isn't the
  // live tail, so there it reads everything, as the pre-divider client did.
  const persist = (id: string) => {
    const target = hasNewerPages ? undefined : newestId;
    const acked = getAckedThrough(id);
    if (target && acked !== undefined && acked >= target) return;
    void markParentRead(queryClient, kind, id, target);
  };
  // Effect-side entry (open, at-bottom flip, window return): reads the latest
  // newestId without making it an effect dependency — a message ARRIVING must not trigger a read here (ChatPage's
  // attention-gated arrival rule owns that; re-reading on every arrival is the
  // ghost-DM bug).
  // It re-reads the store rather than trusting the render-time `atBottom`:
  // on open, the list mounts in the same commit and its (child, so earlier)
  // effect may have just published "not at bottom" — a deep-link landing
  // mid-history — which this render never saw.
  const persistFromEffect = useEffectEvent((id: string) => {
    if (isListAtBottom(id)) persist(id);
  });

  const ready = !!parentID && snap.captured && messagesLoaded;
  useEffect(() => {
    if (!ready || !parentID || !atBottom) return;
    persistFromEffect(parentID);
  }, [ready, parentID, atBottom]);

  // Returning to the window (focus, or the tab becoming visible while
  // focused) re-reads the open parent — only if the user is at the tail;
  // scrolled up, the unread stays for them to scroll down to. Focus alone is
  // enough evidence here (unlike the activity clock): reading the on-screen
  // conversation when its window comes forward is what the user expects,
  // and the alert itself was already delivered while they were away.
  useEffect(() => {
    if (!ready || !parentID) return;
    const openedID = parentID;
    function onReturn(): void {
      if (document.visibilityState !== 'visible') return;
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
      persistFromEffect(openedID);
    }
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [ready, parentID]);

  // Forget the local read position when the view closes.
  useEffect(() => {
    if (!parentID) return;
    return () => clearReadPosition(parentID);
  }, [parentID]);

  // Explicit reads (✕/Esc) persist regardless of scroll.
  const markRead = () => {
    if (parentID) persist(parentID);
  };

  const count = dividerMsgId
    ? countUnreadFrom(messages, dividerMsgId, currentUserId)
    : pending
      ? snap.unreadCount
      : 0;
  const since = dividerMsgId ? messages.find((m) => m.id === dividerMsgId)?.createdAt : undefined;
  const newCount = countUnreadAfter(messages, liveWatermark, currentUserId);

  return { dividerMsgId, pending, count, since, newCount, markRead };
}
