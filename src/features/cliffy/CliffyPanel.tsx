import { useCallback, useEffect, useState } from 'react';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  useThreadRuntime,
} from '@assistant-ui/react';
import { useChatRuntime, AssistantChatTransport } from '@assistant-ui/react-ai-sdk';
import { lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { motion } from 'motion/react';
import { ListTodo, Calendar, SquarePen, ArrowUp, Square, X, RefreshCw, Hash } from 'lucide-react';
import { apiFetch, ApiError, getAccessToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { MarkdownText, ToolFallback, WriteApiToolUI, OpenPageToolUI } from './cliffy-tools';
import { useCliffyStore } from './cliffy-store';
import { CliffBot } from './cliff-bot';
import { CliffyMark } from './cliffy-mark';

type SessionState = 'loading' | 'ready' | 'noaccount' | 'error';

/**
 * Cliffy assistant panel for ex — the PRIVATE assistant (personal, moveable).
 * Shared/together Cliffy lives in the chat itself (@cliffy), not here. Probes
 * /api/v1/cliffy/session first (so a user with no CliffHub account sees a clean
 * "unavailable" state), then mounts the assistant-ui runtime bound to ex's
 * streaming proxy. The CliffHub token is never handled here — ex injects it
 * server-side.
 */
export function CliffyPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SessionState>('loading');
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState('loading');
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ cliffhub_base?: string }>('/api/v1/cliffy/session', { method: 'POST' })
      .then((res) => {
        if (cancelled) return;
        useCliffyStore.getState().setCliffhubBase(res?.cliffhub_base ?? null);
        setState('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState(err instanceof ApiError && err.status === 403 ? 'noaccount' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-gradient-to-b from-primary/[0.06] to-transparent px-3 py-2.5">
        <CliffyMark className="size-8 shrink-0 [filter:drop-shadow(0_0_2px_rgba(0,0,0,0.4))]" />
        <h2 className="flex-1 text-sm font-semibold tracking-tight">Cliffy</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Cliffy"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {state === 'loading' && <Centered>Connecting to Cliffy…</Centered>}
        {state === 'noaccount' && (
          <Centered>Cliffy isn't available for your account — it needs a linked CliffHub profile.</Centered>
        )}
        {state === 'error' && (
          <Centered>
            <div className="flex flex-col items-center gap-3">
              <p>Couldn't reach Cliffy.</p>
              <Button size="sm" variant="outline" onClick={retry}>
                <RefreshCw className="mr-1.5 size-3.5" /> Retry
              </Button>
            </div>
          </Centered>
        )}
        {state === 'ready' && <CliffyRuntime />}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function CliffyRuntime() {
  const [transport] = useState(
    () =>
      new AssistantChatTransport({
        api: '/api/v1/cliffy/chat',
        headers: () => ({ Authorization: `Bearer ${getAccessToken() ?? ''}` }),
        body: () => {
          const scope = useCliffyStore.getState().scope;
          if (!scope) return {};
          // scope → ex's proxy fetches the transcript into context.messages;
          // page → the agent's "current page" hint.
          return {
            context: {
              scope: { type: scope.type, id: scope.id, name: scope.name },
              page: { title: scope.name ?? scope.id, type: 'ex-conversation' },
            },
          };
        },
      }),
  );

  const runtime = useChatRuntime({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WriteApiToolUI />
      <OpenPageToolUI />
      <SeedSender />
      <Thread />
    </AssistantRuntimeProvider>
  );
}

// Sends the one-shot `/cliffy <prompt>` seed once the runtime is mounted.
function SeedSender() {
  const thread = useThreadRuntime();
  useEffect(() => {
    const seed = useCliffyStore.getState().consumeSeed();
    if (seed) {
      thread.append({ role: 'user', content: [{ type: 'text', text: seed }] });
    }
  }, [thread]);
  return null;
}

function Thread() {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-4">
        <ThreadWelcome />
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
      </ThreadPrimitive.Viewport>

      <div className="shrink-0 px-3 pb-2.5 pt-1.5">
        <Composer />
        <p className="mt-1.5 text-center text-xs text-muted-foreground">
          Cliffy can make mistakes — review actions before approving.
        </p>
      </div>
    </ThreadPrimitive.Root>
  );
}

const SUGGESTIONS = [
  { icon: <ListTodo className="size-3.5" />, text: 'Show my open tasks' },
  { icon: <Calendar className="size-3.5" />, text: 'Who is on leave this week?' },
  { icon: <SquarePen className="size-3.5" />, text: 'Create a task' },
];

function ThreadWelcome() {
  const thread = useThreadRuntime();
  return (
    <ThreadPrimitive.Empty>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-2 pb-8 pt-4 text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.85, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 20 }}
          className="relative"
        >
          <span className="absolute inset-0 -z-10 rounded-full bg-brand/20 blur-2xl" />
          <CliffBot className="size-24" />
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
          <p className="cliff-heading-sheen text-base font-semibold">How can I help?</p>
          <p className="mt-1 max-w-[18rem] text-xs text-muted-foreground">
            I can look things up and take actions for you — with your own access.
          </p>
        </motion.div>

        <div className="flex w-full max-w-[20rem] flex-col gap-2">
          {SUGGESTIONS.map((s, i) => (
            <motion.button
              key={s.text}
              type="button"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.12 + i * 0.05 }}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => thread.append({ role: 'user', content: [{ type: 'text', text: s.text }] })}
              className="cliff-shine group flex items-center gap-2.5 rounded-xl border border-border bg-card px-2.5 py-2 text-left text-xs text-muted-foreground shadow-sm transition-colors hover:border-brand/40 hover:bg-accent hover:text-foreground"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand transition-colors group-hover:bg-brand/15">
                {s.icon}
              </span>
              {s.text}
            </motion.button>
          ))}
        </div>
      </div>
    </ThreadPrimitive.Empty>
  );
}

function ScopeChip() {
  const scope = useCliffyStore((s) => s.scope);
  if (!scope) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      <Hash className="size-3" />
      {scope.name ?? scope.id}
    </span>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col rounded-2xl border border-border bg-background shadow-sm transition-all focus-within:border-brand/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-brand/15">
      <ComposerPrimitive.Input
        autoFocus
        rows={1}
        placeholder="Ask Cliffy…"
        className="max-h-40 w-full resize-none border-0 bg-transparent px-3.5 pb-1 pt-2.5 text-sm outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-2 px-2 pb-2 pt-0.5">
        <div className="min-w-0 flex-1">
          <ScopeChip />
        </div>
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send className="cliff-shine flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-all hover:scale-105 active:scale-95 disabled:opacity-30 disabled:shadow-none">
            <ArrowUp className="size-4" />
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel className="flex size-7 shrink-0 items-center justify-center rounded-lg border text-foreground transition-colors hover:bg-accent">
            <Square className="size-3" fill="currentColor" />
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
    </ComposerPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex w-full justify-end">
      <div className="max-w-[85%] animate-in fade-in-0 slide-in-from-bottom-1 rounded-2xl rounded-br-md bg-primary px-3 py-2 text-sm text-primary-foreground shadow-sm">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex w-full gap-2">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
        <CliffBot className="size-5" state="idle" />
      </span>
      <div className="min-w-0 flex-1 animate-in fade-in-0 slide-in-from-bottom-1">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            tools: { Fallback: (p) => <ToolFallback toolName={p.toolName} /> },
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}
