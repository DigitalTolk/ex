import { createContext, memo, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CircleCheck, ExternalLink, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import { expandDateTokens, formatTallyTime } from '@/lib/block-text';
import { externalHref } from '@/lib/url-safety';
import { showToast } from '@/lib/toast';
import { newClickID } from '@/lib/app-clicks';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import type { ActionTally, Block, BlockText, ButtonElement, Message, TextElement } from '@/types';

type NameLookup = { get(id: string): { displayName: string } | undefined };

// What every block of one message shares: where the message lives, whether
// its buttons may be clicked here, who is looking, and the latest state of
// its built-in actions.
interface BlockScopeValue {
  parentType: 'channel' | 'conversation';
  parentID: string;
  messageID: string;
  interactive: boolean;
  // The app posted the message with its token: its app buttons reach it.
  appButtons: boolean;
  currentUserId?: string;
  userMap?: NameLookup;
  tallies?: ActionTally[];
  onResult: (msg: Message) => void;
}

// What a click answers: the message as it now is, and maybe a note for the
// clicker — from the app, or ex's own when the click didn't go through.
interface ClickAnswer {
  message: Message;
  notice?: string;
  failed?: boolean;
}

const BlockScope = createContext<BlockScopeValue | null>(null);

// MessageBlockScope draws a message with blocks. A click's answer (the
// message as the server now has it) shows at once; the broadcast of the same
// change replaces it as soon as it arrives, and anything newer wins.
export function MessageBlockScope({
  message,
  parentType,
  parentID,
  interactive,
  currentUserId,
  userMap,
  children,
}: {
  message: Message;
  parentType?: 'channel' | 'conversation';
  parentID?: string;
  interactive: boolean;
  currentUserId?: string;
  userMap?: NameLookup;
  children: (current: Message) => ReactNode;
}) {
  const [answered, setAnswered] = useState<Message | null>(null);
  // A click's answer stands in for the message until the list catches up —
  // only an answer about this message, and only while it is newer.
  const current = answered && answered.id === message.id && (answered.version ?? 0) > (message.version ?? 0) ? answered : message;
  const value = useMemo<BlockScopeValue | null>(
    () =>
      parentType && parentID
        ? {
            parentType,
            parentID,
            messageID: message.id,
            interactive,
            appButtons: !!current.appButtons,
            currentUserId,
            userMap,
            tallies: current.actionTallies,
            onResult: setAnswered,
          }
        : null,
    [parentType, parentID, message.id, interactive, current.appButtons, currentUserId, userMap, current.actionTallies],
  );
  return <BlockScope.Provider value={value}>{children(current)}</BlockScope.Provider>;
}

// BlockList draws blocks: headers, sections, rows of buttons, context lines
// and dividers. Outside a scope (a preview) its buttons are shown, not live.
export const BlockList = memo(function BlockList({ blocks, className }: { blocks?: Block[]; className?: string }) {
  if (!blocks?.length) return null;
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)} data-testid="message-blocks">
      {blocks.map((block) => (
        <BlockView key={block.block_id} block={block} />
      ))}
    </div>
  );
});

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'header':
      return <div className="text-base font-semibold leading-snug break-words">{expandDateTokens(block.text.text)}</div>;
    case 'section':
      return (
        // A phone has no room beside the text: the button goes under it.
        <div className="flex min-w-0 items-start gap-3 mobile:flex-col mobile:gap-2" data-testid="block-section">
          <div className="min-w-0 flex-1 space-y-1.5">
            {block.text && <BlockTextView text={block.text} />}
            {block.fields?.length ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {block.fields.map((field, index) => (
                  <BlockTextView key={index} text={field} />
                ))}
              </div>
            ) : null}
          </div>
          {block.accessory && (
            <div className="shrink-0">
              <BlockButton blockID={block.block_id} button={block.accessory} />
            </div>
          )}
        </div>
      );
    case 'actions':
      return (
        <div className="flex flex-wrap items-center gap-2" role="group" data-testid="block-actions">
          {block.elements.map((button) => (
            <BlockButton key={button.action_id} blockID={block.block_id} button={button} />
          ))}
        </div>
      );
    case 'context':
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="block-context">
          {block.elements.map((element, index) => (
            <ContextText key={index} element={element} />
          ))}
        </div>
      );
    case 'divider':
      return <hr className="border-border" />;
  }
}

// Text renders like a webhook card's: memoized on its source, since the row
// re-renders for hover, presence and reactions while the text stays put.
const BlockTextView = memo(function BlockTextView({ text }: { text: BlockText }) {
  const source = expandDateTokens(text.text);
  if (text.type === 'markdown') return <div className="prose-message text-sm">{renderMarkdown(source)}</div>;
  return <div className="text-sm whitespace-pre-wrap break-words">{source}</div>;
});

const ContextText = memo(function ContextText({ element }: { element: TextElement }) {
  const source = expandDateTokens(element.text);
  if (element.type === 'markdown') {
    return <div className="prose-message min-w-0 text-xs [&_p]:my-0">{renderMarkdown(source)}</div>;
  }
  return <span className="min-w-0 break-words">{source}</span>;
});

const variantFor = (style: ButtonElement['style']) =>
  style === 'primary' ? 'default' : style === 'danger' ? 'destructive' : 'outline';

function BlockButton({ blockID, button }: { blockID: string; button: ButtonElement }) {
  const scope = useContext(BlockScope);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const tally = scope?.tallies?.find((t) => t.blockID === blockID && t.actionID === button.action_id);
  const label = button.text.text;

  const send = useCallback(async () => {
    /* istanbul ignore next -- the button is disabled outside a live scope, so a click never gets here without one */
    if (!scope) return;
    setPending(true);
    const path = scope.parentType === 'channel' ? 'channels' : 'conversations';
    try {
      const answer = await apiFetch<ClickAnswer>(`/api/v1/${path}/${scope.parentID}/messages/${scope.messageID}/actions`, {
        method: 'POST',
        // The click's ID lets a form the app opens in answer find this tab.
        body: JSON.stringify({ blockID, actionID: button.action_id, clickID: newClickID() }),
      });
      scope.onResult(answer.message);
      // The app's note (or why nothing happened) is for the clicker alone.
      if (answer.notice) showToast(answer.notice, answer.failed ? 'error' : 'success');
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : "That didn't work. Try again.");
    } finally {
      setPending(false);
    }
  }, [scope, blockID, button.action_id]);

  // Only the people the app named see the button.
  if (button.allowed_users?.length && !(scope?.currentUserId && button.allowed_users.includes(scope.currentUserId))) {
    return null;
  }

  const url = button.url ? externalHref(button.url) : undefined;
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={cn(buttonVariants({ variant: variantFor(button.style), size: 'sm' }), 'max-w-full')}
        data-testid={`block-button-${button.action_id}`}
      >
        <span className="truncate">{label}</span>
        <ExternalLink aria-hidden />
      </a>
    );
  }

  if (button.ex_action === 'ack' && tally) {
    const who = tally.userIDs.map((id) => scope?.userMap?.get(id)?.displayName ?? 'Someone').join(', ');
    return (
      <span
        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md bg-muted px-2.5 text-sm text-muted-foreground mobile:h-11 mobile:text-base"
        title={new Date(tally.at).toLocaleString()}
        data-testid={`block-acked-${button.action_id}`}
      >
        <CircleCheck className="size-4 shrink-0 text-online" aria-hidden />
        <span className="truncate">
          Acknowledged by {who} · {formatTallyTime(tally.at)}
        </span>
      </span>
    );
  }

  const isVote = button.ex_action === 'vote';
  const voters = isVote ? (tally?.userIDs ?? []) : [];
  const voted = !!scope?.currentUserId && voters.includes(scope.currentUserId);
  // An app button needs an app to answer it: one that posted the message
  // with its token (anything else could be a forged card).
  const unanswered = !button.ex_action && !scope?.appButtons;
  const live = !!scope?.interactive && !unanswered;
  const hint = unanswered
    ? "This app isn't set up for buttons"
    : isVote && voters.length
      ? voters.map((id) => scope?.userMap?.get(id)?.displayName ?? 'Someone').join(', ')
      : undefined;

  const onClick = () => {
    if (button.confirm) setConfirming(true);
    else void send();
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={variantFor(button.style)}
        className={cn('relative max-w-full', voted && 'border-foreground/40 bg-accent')}
        disabled={!live || pending}
        aria-busy={pending || undefined}
        aria-pressed={isVote ? voted : undefined}
        title={hint}
        onClick={onClick}
        data-testid={`block-button-${button.action_id}`}
      >
        {/* The label keeps its place while loading, so the button — and the
            message row — never change size. */}
        <span className={cn('flex min-w-0 items-center gap-1.5', pending && 'invisible')}>
          <span className="truncate">{label}</span>
          {isVote && voters.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground" data-testid="block-vote-count">
              {voters.length}
            </span>
          )}
        </span>
        {pending && <Loader2 className="absolute animate-spin" aria-label="Sending" />}
      </Button>
      {confirming && button.confirm && (
        <ConfirmDialog
          open
          onOpenChange={setConfirming}
          title={button.confirm.title.text}
          description={button.confirm.text.text}
          confirmLabel={button.confirm.confirm.text}
          cancelLabel={button.confirm.deny.text}
          destructive={button.style === 'danger'}
          onConfirm={() => {
            setConfirming(false);
            void send();
          }}
          testIDPrefix="block-confirm"
        />
      )}
    </>
  );
}
