import { useState } from 'react';
import { Bot, Plus } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/context/AuthContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useAgents, type AgentView } from '@/hooks/useAgents';
import { AgentCard } from './agents/AgentCard';
import { NewAgentForm } from './agents/NewAgentForm';

// AgentsPage: the shared workspace agents (@gg, @qib — they belong to no
// one) with YOUR settings for them. Mentioning an agent runs it on YOUR
// machine via the desktop app, using your local Claude Code / Codex install
// and the prompt/pin you set here.
export default function AgentsPage() {
  useDocumentTitle('Agents');
  const { data: agents, isLoading } = useAgents();
  const { user } = useAuth();
  const isAdmin = user?.systemRole === 'admin';
  const [creating, setCreating] = useState(false);

  return (
    <PageContainer
      title="Agents"
      description="Shared agents anyone can @mention — expand one to set your own prompt and options."
    >
      {isAdmin && (
        <div className="mb-4">
          {creating ? (
            <NewAgentForm onDone={() => setCreating(false)} />
          ) : (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              New agent
            </Button>
          )}
        </div>
      )}

      {isLoading && (
        <div className="space-y-2" data-testid="agents-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {!isLoading && (agents?.length ?? 0) === 0 && (
        <div className="py-12 text-center text-muted-foreground" data-testid="agents-empty">
          <Bot className="mx-auto mb-3 h-8 w-8" />
          <p>No agents configured in this workspace.</p>
        </div>
      )}

      <div className="space-y-2">
        {agents?.map((agent) => (
          // Key includes EVERY server-side pref value the card edits, so a
          // successful save (or an update from another tab) remounts it with
          // fresh form state — no sync effect needed. A pref left out of this
          // key is a pref whose stale form state survives: autoAllow was
          // missing, so granting "Always allow shell" from an approval card
          // left this card holding the old list and the next unrelated save
          // wrote it straight back.
          <AgentCard
            key={agentCardKey(agent)}
            agent={agent}
          />
        ))}
      </div>
    </PageContainer>
  );
}

// agentCardKey fingerprints the prefs AgentCard renders as form state.
function agentCardKey(agent: AgentView): string {
  const p = agent.prefs;
  return [
    agent.slug,
    p.persona ?? '',
    p.harness ?? '',
    p.model ?? '',
    p.executionMode ?? '',
    p.offlinePolicy ?? '',
    p.limits?.maxChainRounds ?? '',
    p.followUpMode ?? '',
    p.followUpMins ?? '',
    p.followUpAsk ?? '',
    (p.autoAllow ?? []).join('|'),
  ].join(':');
}

// NewAgentForm defines a new shared agent (admin-only). The agent becomes
// mentionable workspace-wide immediately; per-user prefs still override.
