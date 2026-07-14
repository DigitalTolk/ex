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
}

// Executes a slash command in a chat. The command's result arrives as a
// normal message over the WebSocket (message.new), so success needs no cache
// work here.
export function useRunCommand() {
  return useMutation({
    mutationFn: (input: RunCommandInput) =>
      apiFetch<{ message: Message }>('/api/v1/commands/run', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}
