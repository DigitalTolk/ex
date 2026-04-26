import { useEffect, useRef, useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEmojis } from '@/hooks/useEmoji';
import { COMMON_EMOJI_SHORTCODES } from '@/lib/emoji-shortcodes';
import { PopoverPortal } from '@/components/PopoverPortal';

type SelectMode = 'shortcode' | 'reaction';

interface EmojiPickerProps {
  // Called when the user picks an emoji. The string is always a `:shortcode:`
  // (so messages and reactions are stored uniformly per the API contract).
  onSelect: (shortcode: string) => void;
  onClose?: () => void;
  trigger?: React.ReactNode;
  ariaLabel?: string;
  // shortcode: insert :name: into a textarea (for the message composer)
  // reaction: emit :name: too — handled identically here
  mode?: SelectMode;
}

export function EmojiPicker({ onSelect, onClose, trigger, ariaLabel = 'Emoji picker' }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: customEmojis } = useEmojis();

  const filteredStandard = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMON_EMOJI_SHORTCODES;
    return COMMON_EMOJI_SHORTCODES.filter((e) =>
      e.name.toLowerCase().includes(q) || e.unicode.includes(q),
    );
  }, [query]);

  const filteredCustom = useMemo(() => {
    if (!customEmojis) return [];
    const q = query.trim().toLowerCase();
    if (!q) return customEmojis;
    return customEmojis.filter((e) => e.name.toLowerCase().includes(q));
  }, [customEmojis, query]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setQuery('');
    onClose?.();
  }

  function handlePick(shortcode: string) {
    onSelect(shortcode);
    close();
  }

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-block"
        onClick={() => setOpen((v) => !v)}
      >
        {trigger ?? (
          <Button size="sm" variant="ghost" aria-label="Open emoji picker">
            😊
          </Button>
        )}
      </span>
      <PopoverPortal
        open={open}
        triggerRef={triggerRef}
        onDismiss={close}
        estimatedHeight={360}
        estimatedWidth={288}
        preferredSide="bottom"
        preferredAlign="end"
        ariaLabel={ariaLabel}
        className="w-72 rounded-md border bg-popover p-2 shadow-md"
      >
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emojis..."
          aria-label="Search emojis"
          className="mb-2 h-8 text-xs"
        />
        {filteredCustom.length > 0 && (
          <div className="mb-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Custom
            </div>
            <div className="grid grid-cols-8 gap-0.5" role="list" aria-label="Custom emojis">
              {filteredCustom.map((e) => (
                <button
                  key={e.name}
                  type="button"
                  role="listitem"
                  onClick={() => handlePick(`:${e.name}:`)}
                  className="h-7 w-7 rounded hover:bg-muted flex items-center justify-center"
                  aria-label={`React with :${e.name}:`}
                  title={`:${e.name}:`}
                >
                  <img src={e.imageURL} alt={`:${e.name}:`} className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Standard
          </div>
          <div className="grid grid-cols-8 gap-0.5 max-h-56 overflow-y-auto" role="list" aria-label="Standard emojis">
            {filteredStandard.map((e) => (
              <button
                key={e.name}
                type="button"
                role="listitem"
                onClick={() => handlePick(`:${e.name}:`)}
                className="h-7 w-7 rounded hover:bg-muted flex items-center justify-center text-sm"
                aria-label={`React with :${e.name}:`}
                title={`:${e.name}:`}
              >
                {e.unicode}
              </button>
            ))}
          </div>
          {filteredStandard.length === 0 && filteredCustom.length === 0 && (
            <p className="py-3 text-center text-xs text-muted-foreground">No emojis found</p>
          )}
        </div>
      </PopoverPortal>
    </>
  );
}
