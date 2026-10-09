import type { ReactNode } from 'react';
import { MessageRowDataContext, useMessageRowData } from '@/hooks/useMessageRowData';

// Subscribes once, for every row below it, to the shared row data (see
// useMessageRowData).
export function MessageRowDataProvider({
  parentType,
  parentID,
  children,
}: {
  parentType: 'channel' | 'conversation';
  parentID: string | undefined;
  children: ReactNode;
}) {
  const data = useMessageRowData(parentType, parentID);
  return <MessageRowDataContext.Provider value={data}>{children}</MessageRowDataContext.Provider>;
}
