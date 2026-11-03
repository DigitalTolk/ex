import { lazy, memo, Suspense, useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, ExternalLink, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import { expandDateTokens, formatTallyTime } from '@/lib/block-text';
import { externalHref } from '@/lib/url-safety';
import { showToast } from '@/lib/toast';
import { newClickID } from '@/lib/app-clicks';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import type { Block, BlockText, ButtonElement, ImageElement, Message, RowElement, TextElement } from '@/types';
import { BlockScope, useBlockScope, type ActValue, type BlockScopeValue } from './blockScope';
import { BlockPicker } from './BlockPickers';
import { noteReceipt, useActionReceipts } from '@/stores/action-receipts';
import { Callout, RichText, Spans, TableBlock } from './RichText';
import { Chart } from './Chart';

type NameLookup = NonNullable<BlockScopeValue['userMap']>;

// What a click answers: the message as it now is, and maybe a note for the
// clicker — from the app, or ex's own when the click didn't go through.
interface ClickAnswer {
  message: Message;
  notice?: string;
  failed?: boolean;
}

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
  const messageID = message.id;
  const act = useCallback(
    async (blockID: string, actionID: string, value?: ActValue, summary?: string) => {
      const path = parentType === 'channel' ? 'channels' : 'conversations';
      // Whatever the click leads to meanwhile (a form opening) is newer
      // than the click's own line, and stays.
      const since = Date.now();
      try {
        const answer = await apiFetch<ClickAnswer>(`/api/v1/${path}/${parentID}/messages/${messageID}/actions`, {
          method: 'POST',
          // The click's ID lets a form the app opens in answer find this tab
          // — and the form find this card.
          body: JSON.stringify({ blockID, actionID, clickID: newClickID({ messageID }), ...(value !== undefined && { value }) }),
        });
        setAnswered(answer.message);
        // The app's note (or why nothing happened) is for the clicker alone.
        if (answer.notice) showToast(answer.notice, answer.failed ? 'error' : 'success');
        if (summary) noteReceipt(messageID, { text: summary, notice: answer.notice, failed: answer.failed }, since);
      } catch (err) {
        const why = err instanceof Error && err.message ? err.message : "That didn't work. Try again.";
        showToast(why);
        if (summary) noteReceipt(messageID, { text: summary, notice: why, failed: true });
      }
    },
    [parentType, parentID, messageID],
  );
  const value = useMemo<BlockScopeValue | null>(
    () =>
      parentType && parentID
        ? {
            interactive,
            appButtons: !!current.appButtons,
            idPrefix: `msg-${messageID}`,
            currentUserId,
            userMap,
            tallies: current.actionTallies,
            act,
          }
        : null,
    [parentType, parentID, messageID, interactive, current.appButtons, currentUserId, userMap, current.actionTallies, act],
  );
  return (
    <BlockScope.Provider value={value}>
      {children(current)}
      <ActionReceiptLine messageID={messageID} />
    </BlockScope.Provider>
  );
}

// ActionReceiptLine says, under a card, what this person last did on it and
// what the app answered — so a card the app replaced (or a choice that only
// flashed a toast) still shows it.
function ActionReceiptLine({ messageID }: { messageID: string }) {
  const receipt = useActionReceipts((s) => s.byMessage[messageID]);
  const [showDetails, setShowDetails] = useState(false);
  if (!receipt) return null;
  return (
    <p
      className={cn('mt-1.5 flex items-start gap-1.5 text-xs', receipt.failed ? 'text-destructive' : 'text-muted-foreground')}
      role="status"
      data-testid="action-receipt"
    >
      {receipt.failed ? (
        <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      ) : (
        <CircleCheck className="mt-px size-3.5 shrink-0 text-online" aria-hidden />
      )}
      <span className="min-w-0 break-words">
        {receipt.failed ? `${receipt.text} — didn't go through` : receipt.text} · {formatTallyTime(new Date(receipt.at).toISOString())}
        {receipt.notice && <span className={cn(!receipt.failed && 'text-foreground')}> — {receipt.notice}</span>}
        {receipt.details && (
          <>
            {' · '}
            <button
              type="button"
              className="font-medium text-foreground underline-offset-2 hover:underline"
              onClick={() => setShowDetails(true)}
              data-testid="action-receipt-details"
            >
              View details
            </button>
          </>
        )}
      </span>
      {showDetails && receipt.details && (
        <Suspense fallback={null}>
          <SentDetailsDialog details={receipt.details} at={receipt.at} onClose={() => setShowDetails(false)} />
        </Suspense>
      )}
    </p>
  );
}

// What was sent loads only when someone asks to see it.
const SentDetailsDialog = lazy(() => import('@/components/apps/SentDetailsDialog'));

// ActScope makes blocks live outside a message — a form's buttons and
// pickers, which send to the form's actions.
export function ActScope({ act, idPrefix, currentUserId, children }: Pick<BlockScopeValue, 'act' | 'idPrefix' | 'currentUserId'> & { children: ReactNode }) {
  const value = useMemo<BlockScopeValue>(() => ({ interactive: true, appButtons: true, idPrefix, currentUserId, act }), [act, idPrefix, currentUserId]);
  return <BlockScope.Provider value={value}>{children}</BlockScope.Provider>;
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
          {block.accessory &&
            (block.accessory.type === 'image' ? (
              <BlockImage image={block.accessory} className="size-14 shrink-0 rounded-md mobile:order-first" />
            ) : (
              <div className="shrink-0">
                <RowItem blockID={block.block_id} element={block.accessory} />
              </div>
            ))}
        </div>
      );
    case 'actions':
      return (
        <div className="flex flex-wrap items-center gap-2" role="group" data-testid="block-actions">
          {block.elements.map((element) => (
            <RowItem key={element.action_id} blockID={block.block_id} element={element} />
          ))}
        </div>
      );
    case 'context':
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="block-context">
          {block.elements.map((element, index) =>
            element.type === 'image' ? (
              <BlockImage key={index} image={element} className="size-5 shrink-0 rounded-sm" />
            ) : (
              <ContextText key={index} element={element} />
            ),
          )}
        </div>
      );
    case 'divider':
      return <hr className="border-border" />;
    case 'image':
      return <ImageBlock block={block} />;
    case 'rich_text':
      return <RichText content={block.content} />;
    case 'callout':
      return <Callout block={block} />;
    case 'table':
      return <TableBlock block={block} />;
    case 'toggle':
      return <ToggleBlock block={block} />;
    case 'chart':
      return <Chart block={block} />;
    case 'columns':
      return <ColumnsBlock block={block} />;
    case 'column':
      // Only ever inside columns, which draws its own.
      return null;
  }
}

// ColumnsBlock lays its columns side by side in their width shares — when
// the message has room for them. A container query, not the screen: in a
// narrow thread panel or on a phone the columns stack.
function ColumnsBlock({ block }: { block: Extract<Block, { type: 'columns' }> }) {
  const columns = block.blocks.filter((c): c is Extract<Block, { type: 'column' }> => c.type === 'column');
  const shares = columns.map((c) => `${c.width ?? 1}fr`).join(' ');
  return (
    <div className="@container min-w-0" data-testid="block-columns">
      <div className="grid grid-cols-1 gap-3 @lg:grid-cols-[var(--ex-columns)]" style={{ ['--ex-columns' as string]: shares }}>
        {columns.map((column) => (
          <div key={column.block_id} className="min-w-0" data-testid="block-column">
            <BlockList blocks={column.blocks} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ToggleBlock shows its summary and, once opened, the blocks under it. A
// closed toggle renders nothing beneath it, so long logs cost nothing until
// someone asks; the row grows when the reader opens it, not on its own.
function ToggleBlock({ block }: { block: Extract<Block, { type: 'toggle' }> }) {
  const [open, setOpen] = useState(!!block.open);
  const bodyID = useId();
  return (
    <div data-testid="block-toggle" className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyID}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full items-start gap-1 rounded-md py-0.5 pr-1.5 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')}
        />
        <span className="min-w-0 break-words">
          <Spans spans={block.summary} inert />
        </span>
      </button>
      {open && (
        <div id={bodyID} className="mt-1.5 ml-2 border-l border-border pl-3.5">
          <BlockList blocks={block.blocks} />
        </div>
      )}
    </div>
  );
}

// RowItem is one element of an actions row or a section's accessory: a
// button, or a picker.
function RowItem({ blockID, element }: { blockID: string; element: RowElement }) {
  return element.type === 'button' ? <BlockButton blockID={blockID} button={element} /> : <BlockPicker blockID={blockID} element={element} />;
}

// BlockImage is a small picture at a fixed size (an accessory, a context
// row's icon): its box never waits on the image to load.
function BlockImage({ image, className }: { image: ImageElement; className: string }) {
  return <img src={image.image_url} alt={image.alt_text} title={image.alt_text} loading="lazy" className={cn('bg-muted object-cover', className)} />;
}

// The widest an image block draws, in CSS pixels.
const IMAGE_MAX = 400;

// ImageBlock is a picture on its own. Its box is set before it loads — from
// the size ex measured, else a fixed 16:9 frame — so the message list never
// shifts under the reader. Clicking opens the full picture.
function ImageBlock({ block }: { block: Extract<Block, { type: 'image' }> }) {
  const w = block.image_width ?? 0;
  const h = block.image_height ?? 0;
  const known = w > 0 && h > 0;
  const width = known ? Math.min(w, IMAGE_MAX) : IMAGE_MAX;
  return (
    <figure className="flex min-w-0 flex-col gap-1.5" data-testid="block-image">
      {block.text && <figcaption className="text-sm font-medium break-words">{block.text.text}</figcaption>}
      <a href={externalHref(block.image_url)} target="_blank" rel="noreferrer" className="block w-fit max-w-full" aria-label={`Open image: ${block.alt_text}`}>
        <img
          src={block.image_url}
          alt={block.alt_text}
          loading="lazy"
          width={width}
          height={known ? Math.round((width * h) / w) : Math.round((width * 9) / 16)}
          style={{ maxWidth: '100%', aspectRatio: known ? `${w} / ${h}` : '16 / 9' }}
          className={cn('h-auto rounded-lg border border-border bg-muted', known ? 'object-contain' : 'object-cover')}
        />
      </a>
    </figure>
  );
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
  const scope = useBlockScope();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const tally = scope?.tallies?.find((t) => t.blockID === blockID && t.actionID === button.action_id);
  const label = button.text.text;

  const send = useCallback(async () => {
    /* v8 ignore next -- the button is disabled outside a live scope, so a click never gets here without one */
    /* istanbul ignore next -- the button is disabled outside a live scope, so a click never gets here without one */
    if (!scope) return;
    setPending(true);
    // Built-in actions show their own state on the card; an app button
    // leaves a line saying it was clicked.
    await scope.act(blockID, button.action_id, undefined, button.ex_action ? undefined : `You clicked “${label}”`);
    setPending(false);
  }, [scope, blockID, button.action_id, button.ex_action, label]);

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
