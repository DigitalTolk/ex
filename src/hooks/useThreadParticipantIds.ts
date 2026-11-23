import { useMemo } from 'react';
import type { Message } from '@/types';

// useThreadParticipantIds lists who has written in a thread (its root and
// replies), for the reply composer's @-list to put first. The array keeps
// its identity until someone new writes, so a reply from someone already
// there doesn't re-render the memoised composer.
export function useThreadParticipantIds(messages: Message[] | undefined): string[] | undefined {
  const key = useMemo(
    () => [...new Set((messages ?? []).map((m) => m.authorID).filter(Boolean))].join(','),
    [messages],
  );
  return useMemo(() => (key ? key.split(',') : undefined), [key]);
}
