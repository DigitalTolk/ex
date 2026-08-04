import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { Message } from '@/types';

// Slash commands (server-defined). GET /api/v1/commands lists only the
// commands whose integrations are configured — an empty list simply disables
// the composer's "/" popup, so no separate feature flag is needed.

export interface CommandInfo {
  name: string;
  description: string;
}

export function useCommands(enabled = true) {
  return useQuery<CommandInfo[]>({
    queryKey: ['commands'],
    queryFn: async () => {
      const res = await apiFetch<{ commands: CommandInfo[] }>('/api/v1/commands');
      return Array.isArray(res?.commands) ? res.commands : [];
    },
    enabled,
    // The registry only changes on deploy/config change; refetching per
    // composer mount would be noise.
    staleTime: 5 * 60_000,
  });
}

export interface RunCommandInput {
  command: string;
  parentType: 'channel' | 'conversation';
  parentID: string;
  /** Everything typed after the trigger word. Built-in commands take none;
   *  external (Mattermost-shaped) ones receive it as MM's `text` field. */
  text?: string;
}

export interface RunCommandResult {
  /** The post the command made, if it posted in-channel. */
  message?: Message;
  /** A reply for the invoking user only — shown in the composer, never posted. */
  ephemeral_text?: string;
  /** An http(s) URL the command asked the client to open. Server-filtered. */
  goto_location?: string;
}

// Executes a slash command in a chat. An in-channel result also arrives as a
// normal message over the WebSocket (message.new), so success needs no cache
// work here; ephemeral_text is the part only this caller ever sees.
export function useRunCommand() {
  return useMutation({
    mutationFn: (input: RunCommandInput) =>
      apiFetch<RunCommandResult>('/api/v1/commands/run', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}
