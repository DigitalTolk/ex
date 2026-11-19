import { createContext, useContext } from 'react';
import type { ActionTally } from '@/types';

type NameLookup = { get(id: string): { displayName: string } | undefined };

// A use of an element: which one, and what was picked (a picker's value; a
// list for checkboxes and multi-selects; nothing for a button).
export type ActValue = string | string[] | undefined;

// What every block of one message — or one form — shares: whether its
// elements may be used here, who is looking, the latest state of its
// built-in actions, and how to send a use of an element. A message sends
// to the message's actions; a form to the form's.
export interface BlockScopeValue {
  interactive: boolean;
  // The app posted the message with its token (a form: always): its
  // elements reach it.
  appButtons: boolean;
  // Prefixes element IDs in the page, so two cards never share one.
  idPrefix: string;
  currentUserId?: string;
  userMap?: NameLookup;
  tallies?: ActionTally[];
  // Sends one use. It shows any answer (a notice, an error) itself and
  // resolves once done; it never throws. summary says what the person did
  // ("You chose “P1”"), for the line a message keeps under its card.
  act: (blockID: string, actionID: string, value?: ActValue, summary?: string) => Promise<void>;
}

export const BlockScope = createContext<BlockScopeValue | null>(null);

export const useBlockScope = () => useContext(BlockScope);

export const elementDomID = (scope: BlockScopeValue | null, blockID: string, actionID: string) =>
  `${scope?.idPrefix ?? 'preview'}-${blockID}-${actionID}`.replace(/[^A-Za-z0-9_-]/g, '_');
