import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Lock, MessageSquare, Trash2, Users } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useDeleteDraft, useDrafts } from '@/hooks/useDrafts';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { formatLongDateTime, slugify } from '@/lib/format';
import { toPlainTextPreview } from '@/lib/message-preview';
import type { MessageDraft } from '@/types';

export default function DraftsPage() {
  useDocumentTitle('Drafts');
  const { data: drafts, isLoading } = useDrafts();
  const { data: channels } = useUserChannels();
  const { data: conversations } = useUserConversations();
  const deleteDraft = useDeleteDraft();
  const [draftToDelete, setDraftToDelete] = useState<MessageDraft | null>(null);

  const channelName = (id: string) =>
    channels?.find((c) => c.channelID === id)?.channelName ?? '';
  const channelType = (id: string) =>
    channels?.find((c) => c.channelID === id)?.channelType;
  const conversationName = (id: string) =>
    conversations?.find((c) => c.conversationID === id)?.displayName ?? 'Conversation';
  const conversationType = (id: string) =>
    conversations?.find((c) => c.conversationID === id)?.type;

  const deletePreview = draftToDelete ? draftPreview(draftToDelete) : '';

  return (
    <PageContainer title="Drafts" description="Messages you started but haven't sent yet.">
      {isLoading && (
        <div className="space-y-3" data-testid="drafts-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {!isLoading && (drafts?.length ?? 0) === 0 && (
        <p className="py-12 text-center text-muted-foreground" data-testid="drafts-empty">
          No drafts.
        </p>
      )}

      <div className="space-y-3">
        {!isLoading &&
          drafts?.map((draft) => {
            const title =
              draft.parentType === 'channel'
                ? `~${channelName(draft.parentID) || 'channel'}`
                : conversationName(draft.parentID);
            const parentIcon = draftParentIcon({
              parentType: draft.parentType,
              channelType: channelType(draft.parentID),
              conversationType: conversationType(draft.parentID),
            });
            return (
              <article
                key={draft.id}
                className="flex items-start gap-3 rounded-lg border bg-card p-3"
                data-testid="draft-row"
              >
                <Link to={draftHref(draft, channelName(draft.parentID))} className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    {parentIcon}
                    <span className="truncate">{title}</span>
                    {draft.parentMessageID && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                        thread
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {draftPreview(draft)}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Updated {formatLongDateTime(draft.updatedAt)}
                  </p>
                </Link>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 rounded-md max-md:h-9 max-md:w-9"
                  aria-label="Delete draft"
                  onClick={() => setDraftToDelete(draft)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </article>
            );
          })}
      </div>
      <ConfirmDialog
        open={draftToDelete !== null}
        onOpenChange={() => setDraftToDelete(null)}
        title="Delete draft?"
        description={
          deletePreview
            ? `This will permanently delete "${deletePreview}".`
            : 'This will permanently delete this draft.'
        }
        confirmLabel="Delete draft"
        destructive
        testIDPrefix="delete-draft-dialog"
        onConfirm={() => {
          deleteDraft.mutate(draftToDelete!);
        }}
      />
    </PageContainer>
  );
}

function draftParentIcon({
  parentType,
  channelType,
  conversationType,
}: {
  parentType: MessageDraft['parentType'];
  channelType?: 'public' | 'private';
  conversationType?: 'dm' | 'group';
}) {
  const className = 'h-4 w-4 shrink-0 text-muted-foreground';
  if (parentType === 'channel') {
    return channelType === 'private'
      ? <Lock className={className} aria-hidden data-testid="draft-parent-private-channel-icon" />
      : <Globe className={className} aria-hidden data-testid="draft-parent-public-channel-icon" />;
  }
  return conversationType === 'group'
    ? <Users className={className} aria-hidden data-testid="draft-parent-group-icon" />
    : <MessageSquare className={className} aria-hidden data-testid="draft-parent-dm-icon" />;
}

function draftHref(draft: MessageDraft, channelName: string): string {
  const base =
    draft.parentType === 'channel'
      ? `/channel/${slugify(channelName) || draft.parentID}`
      : `/conversation/${draft.parentID}`;
  if (!draft.parentMessageID) return base;
  return `${base}?thread=${draft.parentMessageID}#msg-${draft.parentMessageID}`;
}

function draftPreview(draft: MessageDraft): string {
  return toPlainTextPreview(draft.body) || 'Attachment draft';
}
