import { Link } from 'react-router-dom';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useEmojiMap } from '@/hooks/useEmoji';
import { useMessageParent } from '@/hooks/useMessageParent';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { formatLongDateTime, getInitials } from '@/lib/format';
import { renderMarkdown } from '@/lib/markdown';
import type { SearchHit } from '@/hooks/useSearch';

export interface MessageHitCardProps {
  hit: SearchHit;
  // When set, clicking the author filters instead of navigating.
  onAuthorClick?: (id: string) => void;
}

export function MessageHitCard({ hit, onAuthorClick }: MessageHitCardProps) {
  const authorId = String(hit._source.authorId ?? '');
  const parentId = String(hit._source.parentId ?? '');
  const threadRoot = String(hit._source.parentMessageID ?? '') || undefined;
  const body = String(hit._source.body ?? '');
  const created = hit._source.createdAt
    ? formatLongDateTime(String(hit._source.createdAt))
    : '';
  const reactions = (hit._source.reactions as Record<string, string[]> | undefined) ?? {};
  const reactionEntries = Object.entries(reactions).filter(([, ids]) => ids.length > 0);

  const { map: authorMap } = useUsersBatch(authorId ? [authorId] : []);
  const author = authorMap.get(authorId);
  const { data: emojiMap = {} } = useEmojiMap();
  const parent = useMessageParent(parentId, hit.id, threadRoot);

  const name = author?.displayName ?? 'Unknown';

  const inner = (
    <article
      data-testid="message-hit-card"
      className="flex items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/40"
    >
      <Avatar className="h-9 w-9 shrink-0">
        {author?.avatarURL && <AvatarImage src={author.avatarURL} alt="" />}
        <AvatarFallback className="text-xs">{getInitials(name || '??')}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          {onAuthorClick ? (
            <button
              type="button"
              onClick={(e) => {
                // Stop the surrounding <Link> from navigating — clicking
                // the author name is a filter action, not a jump.
                e.preventDefault();
                e.stopPropagation();
                if (authorId) onAuthorClick(authorId);
              }}
              className="font-semibold hover:underline"
              title="Filter results from this person"
            >
              {name}
            </button>
          ) : (
            <span className="font-semibold">{name}</span>
          )}
          {parent && (
            <span className="truncate text-muted-foreground">
              {threadRoot ? 'replied in' : 'in'} {parent.label}
            </span>
          )}
          {created && (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{created}</span>
          )}
        </div>
        <div className="mt-1 text-sm prose-message">
          {renderMarkdown(body, { emojiMap })}
        </div>
        {reactionEntries.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {reactionEntries.map(([emoji, userIds]) => (
              <span
                key={emoji}
                className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-1.5 py-0.5 text-xs"
              >
                <EmojiGlyph emoji={emoji} customMap={emojiMap} />
                <span className="tabular-nums text-muted-foreground">{userIds.length}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );

  if (!parent) return inner;
  return (
    <Link to={parent.href} className="block">
      {inner}
    </Link>
  );
}
