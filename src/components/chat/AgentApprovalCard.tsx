import { useState, type ReactNode } from "react";
import {
  Bot,
  Check,
  ListChecks,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  AUTO_ALLOW_CLASSES,
  useAgents,
  useUpdateAgentPrefs,
} from "@/hooks/useAgents";
import {
  settleApprovalLocally,
  useAgentApprovalsFor,
  type PendingApproval,
} from "@/stores/agent-approvals";
import type { UserMapEntry } from "./MessageList";

interface Props {
  parentID?: string;
  userMap?: Record<string, UserMapEntry>;
}

// renderInlineCode renders `code spans` in an approval summary as chips —
// tool-permission summaries carry commands/paths in backticks and read far
// better styled than as raw punctuation.
function renderInlineCode(text: string): ReactNode[] {
  const parts = text.split("`");
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <code
        key={`c-${i}-${part}`}
        className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]"
      >
        {part}
      </code>
    ) : (
      <span key={`t-${i}-${part.slice(0, 8)}`}>{part}</span>
    ),
  );
}

// AgentApprovalCard: the human-in-the-loop gate (plan-v2 §7). When an agent
// calls request_approval (or a native tool hits the permission gateway), its
// run parks and this card appears above the composer FOR THE INVOKER — the
// only person allowed to decide, because the run acts with their
// permissions. Approve/Deny resolves inside the agent's blocked tool call;
// ignoring it resolves as a timeout-denial server-side. ask_user renders as
// a choice list instead.
export function AgentApprovalCard({ parentID, userMap }: Props) {
  const { user } = useAuth();
  const approvals = useAgentApprovalsFor(parentID ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  // "Always allow reads for gg": flips the caller's per-agent pref, then
  // approves this card. Needs the agent roster (id → slug + current prefs).
  const { data: roster } = useAgents();
  const updatePrefs = useUpdateAgentPrefs();

  // "Tell it what to do instead": free text that rides the decision to the
  // agent — the deny message of a permission prompt, or the note inside a
  // request_approval / ask_user result. Approve-with-note works too.
  const [notes, setNotes] = useState<Record<string, string>>({});

  const mine = approvals.filter((a) => a.invokerID === user?.id);
  if (!parentID || mine.length === 0) return null;

  const alwaysAllow = async (a: PendingApproval) => {
    const agent = roster?.find((r) => r.id === a.agentID);
    /* istanbul ignore if -- the button only renders when the same render's roster/kind predicate holds */
    if (!agent || !a.kind) return;
    setBusy(a.approvalID);
    try {
      const current = agent.prefs.autoAllow ?? [];
      if (!current.includes(a.kind)) {
        await updatePrefs.mutateAsync({
          slug: agent.slug,
          patch: { autoAllow: [...current, a.kind] },
        });
      }
    } catch {
      // Pref save failed — still honor the one-off approval below.
    }
    // The pref reaches the runner on its NEXT run; this run's pending gates
    // of the same kind are approved right here so the user isn't asked again.
    const sameKind = mine.filter(
      (m) => m.kind === a.kind && m.agentID === a.agentID,
    );
    for (const m of sameKind) {
      try {
        await apiFetch(`/api/v1/runs/${m.runID}/approvals/${m.approvalID}`, {
          method: "POST",
          body: JSON.stringify({ approve: true }),
        });
      } catch {
        // settled already / transient
      } finally {
        settleApprovalLocally(m.approvalID);
      }
    }
    setBusy(null);
  };

  const decide = async (
    approvalID: string,
    runID: string,
    approve: boolean,
    choice?: string,
    text?: string,
  ) => {
    setBusy(approvalID);
    try {
      await apiFetch(`/api/v1/runs/${runID}/approvals/${approvalID}`, {
        method: "POST",
        body: JSON.stringify({ approve, choice, text }),
      });
    } catch {
      // Already settled (raced the timeout) or transient — either way the
      // event stream/sweep reconciles the card; nothing useful to surface.
    } finally {
      settleApprovalLocally(approvalID);
      setBusy(null);
    }
  };

  return (
    <div
      className="pointer-events-auto mb-1 ml-1 flex w-fit max-w-xl flex-col gap-2"
      aria-live="polite"
    >
      {mine.map((a) => {
        const isReply = !!a.replyText;
        const isChoice = !isReply && (a.options?.length ?? 0) > 0;
        const isBusy = busy === a.approvalID;
        const agentLabel = userMap?.[a.agentID]?.displayName ?? "agent";
        return (
          <div
            key={a.approvalID}
            data-testid="agent-approval-card"
            className="w-full overflow-hidden rounded-xl border border-amber-500/30 bg-background/95 shadow-lg backdrop-blur"
          >
            {/* Identity strip: who is asking, and what kind of ask it is. */}
            <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/20">
                <Bot
                  className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
              </span>
              <span className="text-xs font-semibold">
                {agentLabel}
                <span className="font-normal text-muted-foreground">
                  {isReply
                    ? " drafted a reply"
                    : isChoice
                      ? " needs you to pick an option"
                      : " is waiting for your approval"}
                </span>
              </span>
              <span className="ml-auto flex items-center gap-1 text-[10px] uppercase tracking-wide text-amber-600/80 dark:text-amber-400/80">
                {isChoice ? (
                  <ListChecks className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                )}
                {a.risk ||
                  (isReply
                    ? "draft reply"
                    : isChoice
                      ? "question"
                      : "approval")}
              </span>
            </div>

            <div className="px-3 py-2.5">
              {isReply ? (
                <ReplyProposal approval={a} busy={isBusy} onDecide={decide} />
              ) : (
                <>
                  <div className="text-xs leading-relaxed">
                    {renderInlineCode(a.summary)}
                  </div>

                  {isChoice ? (
                    // ask_user: one row per option; picking settles the gate with
                    // that choice. Dismiss = "decide yourself".
                    <div className="mt-2.5 space-y-1.5">
                      {a.options?.map((opt, i) => (
                        <button
                          key={opt}
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void decide(a.approvalID, a.runID, true, opt)
                          }
                          className="flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-xs transition-colors hover:border-primary/50 hover:bg-accent disabled:opacity-50"
                        >
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px] text-muted-foreground">
                            {i + 1}
                          </span>
                          <span className="min-w-0 break-words font-medium">
                            {opt}
                          </span>
                        </button>
                      ))}
                      <div className="flex justify-end pt-0.5">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void decide(a.approvalID, a.runID, false)
                          }
                          className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                        >
                          Dismiss — let it decide
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <textarea
                        aria-label={`Tell ${agentLabel} what to do`}
                        data-testid="approval-note"
                        placeholder={`Tell ${agentLabel} what to do instead (optional) — sent with your decision`}
                        className="mt-2 min-h-[38px] w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-xs leading-relaxed placeholder:text-muted-foreground/70"
                        value={notes[a.approvalID] ?? ""}
                        onChange={(e) =>
                          setNotes((prev) => ({
                            ...prev,
                            [a.approvalID]: e.target.value,
                          }))
                        }
                        disabled={isBusy}
                        rows={1}
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void decide(
                              a.approvalID,
                              a.runID,
                              true,
                              undefined,
                              notes[a.approvalID]?.trim() || undefined,
                            )
                          }
                          className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {isBusy ? (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {notes[a.approvalID]?.trim()
                            ? "Approve with note"
                            : "Approve"}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void decide(
                              a.approvalID,
                              a.runID,
                              false,
                              undefined,
                              notes[a.approvalID]?.trim() || undefined,
                            )
                          }
                          className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
                          data-testid="approval-deny"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                          {notes[a.approvalID]?.trim()
                            ? "No — do this instead"
                            : "Deny"}
                        </button>
                        {a.kind && roster?.some((r) => r.id === a.agentID) && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void alwaysAllow(a)}
                            data-testid="approval-always-allow"
                            title={`Stop asking when ${agentLabel} wants to ${AUTO_ALLOW_CLASSES.find((c) => c.id === a.kind)?.label.toLowerCase() ?? a.kind} — saved in your agent settings; approves every pending ${a.kind} request too`}
                            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                          >
                            <ShieldCheck
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                            Always allow{" "}
                            {AUTO_ALLOW_CLASSES.find(
                              (c) => c.id === a.kind,
                            )?.label.toLowerCase() ?? a.kind}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ReplyProposal renders a propose_reply card: the agent's drafted reply in an
// editable box, with Send (posts the edited text) and Cancel (posts nothing —
// the user replies themselves). This is the "watcher drafts, you approve/edit"
// flow — the agent did the work; the human keeps final say.
function ReplyProposal({
  approval,
  busy,
  onDecide,
}: {
  approval: PendingApproval;
  busy: boolean;
  onDecide: (
    approvalID: string,
    runID: string,
    approve: boolean,
    choice?: string,
    text?: string,
  ) => Promise<void>;
}) {
  const [text, setText] = useState(/* istanbul ignore next -- ReplyProposal mounts only when replyText is truthy */ approval.replyText ?? "");
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Edit if you like, then send — or cancel and reply yourself.
      </p>
      <textarea
        aria-label="Drafted reply"
        data-testid="reply-proposal-text"
        className="min-h-[72px] w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs leading-relaxed"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() =>
            void onDecide(
              approval.approvalID,
              approval.runID,
              true,
              undefined,
              text,
            )
          }
          data-testid="reply-proposal-send"
          className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Send reply
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void onDecide(approval.approvalID, approval.runID, false)
          }
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Cancel — I&apos;ll reply
        </button>
      </div>
    </div>
  );
}
