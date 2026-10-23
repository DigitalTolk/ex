import { useCallback, useMemo, useState } from 'react';
import { useCommands, useRunCommand } from '@/hooks/useCommands';
import { ApiError } from '@/lib/api';

// commandDenialMessage extracts a server-authored, user-facing denial from a
// failed slash-command run (the backend marks those with a structured error
// message, e.g. "guests can't start Teams meetings"). Anything else — network
// failures, generic 500s — returns null and the caller shows the retry text.
function commandDenialMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const payload = err.payload as { error?: { message?: unknown } } | undefined;
  const message = payload?.error?.message;
  return typeof message === 'string' && message !== '' ? message : null;
}

// What submitting a message did with it, command-wise:
//   'not-a-command' — post it as a normal message;
//   'started'       — a registered slash command is now running instead;
//   'busy'          — a command is already running, so the re-submit is dropped.
export type SlashCommandOutcome = 'not-a-command' | 'started' | 'busy';

interface SlashCommandsOptions {
  variant: 'composer' | 'inline';
  submitLabel?: string;
  onCancel?: () => void;
  typingParentID?: string;
  typingParentType?: 'channel' | 'conversation';
  typingThreadRootID?: string;
}

// useSlashCommands runs a message that is exactly a registered slash command
// (e.g. /mstmeetings) on the server instead of posting it, and tracks the
// running command and its failure for the composer's status lines.
export function useSlashCommands({
  variant,
  submitLabel,
  onCancel,
  typingParentID,
  typingParentType,
  typingThreadRootID,
}: SlashCommandsOptions) {
  // Slash commands run only from a main chat composer: an edit box rewrites an
  // existing message and a thread reply box targets a thread — neither is a
  // place to start a meeting from.
  const commandTarget = useMemo(
    () =>
      variant === 'composer' && submitLabel === undefined && onCancel === undefined &&
      typingThreadRootID === undefined && typingParentID && typingParentType
        ? { parentID: typingParentID, parentType: typingParentType }
        : undefined,
    [variant, submitLabel, onCancel, typingThreadRootID, typingParentID, typingParentType],
  );
  const { data: commands = [] } = useCommands(commandTarget !== undefined);
  const { mutate: runCommand } = useRunCommand();
  const [commandError, setCommandError] = useState('');
  // Name of the slash command currently executing server-side. Commands like
  // /mstmeetings take a few seconds (a Graph round-trip) before their result
  // message lands over the WebSocket — this drives a "Running /x…" status so
  // the composer never looks like it swallowed the command.
  const [pendingCommand, setPendingCommand] = useState('');
  const slashCommandsProvider = useCallback(() => commands, [commands]);

  const submitCommand = useCallback((trimmed: string, hasAttachments: boolean): SlashCommandOutcome => {
    // A message that is exactly a registered slash command (no attachments)
    // executes instead of posting; anything else — including unknown
    // "/words" — sends as a normal message.
    const commandName = (() => {
      if (!commandTarget || hasAttachments) return null;
      const name = /^\/([\w-]+)$/.exec(trimmed)?.[1]?.toLowerCase();
      return name && commands.some((c) => c.name === name) ? name : null;
    })();
    // While a command is in flight, swallow a re-submitted command (double
    // Enter must not start two meetings) — the status line is already up.
    // Normal messages still send.
    if (commandName && pendingCommand) return 'busy';
    setCommandError('');
    if (!commandName) return 'not-a-command';
    setPendingCommand(commandName);
    runCommand(
      { command: commandName, parentType: commandTarget!.parentType, parentID: commandTarget!.parentID },
      {
        onSettled: () => setPendingCommand(''),
        onError: (err) =>
          setCommandError(
            commandDenialMessage(err) ?? `Couldn't run /${commandName} — please try again.`,
          ),
      },
    );
    return 'started';
  }, [commandTarget, commands, runCommand, pendingCommand]);

  return {
    // The composer's `/` typeahead — offered only where commands can run.
    slashCommands: commandTarget ? slashCommandsProvider : undefined,
    commandError,
    pendingCommand,
    submitCommand,
  };
}
