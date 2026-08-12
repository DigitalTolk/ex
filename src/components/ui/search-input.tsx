import { Search, type LucideIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A text field with a leading glyph inside it — the directory searches, the
 * custom-emoji filter, the member-list add box.
 *
 * It exists because the hand-rolled version of this (a `relative` wrapper, an
 * absolutely positioned icon, and a `pl-*` on the Input) is a trap on the
 * mobile tier: the Input's own base class carries `mobile:px-4`, and a
 * VARIANT utility outranks the consumer's plain `pl-8`/`pl-9` no matter which
 * order they are passed in. The override silently evaporated below 768px and
 * the glyph sat on top of the placeholder. Owning the icon and its matching
 * padding in one place makes that unrepresentable — the padding is always
 * restated at the same `mobile:` variant as the thing it has to beat.
 */
interface SearchInputProps extends React.ComponentProps<typeof Input> {
  /** Leading glyph. Defaults to a magnifier. */
  icon?: LucideIcon;
  /** Classes for the positioning wrapper (width, margins). */
  containerClassName?: string;
}

export function SearchInput({
  icon: Icon = Search,
  className,
  containerClassName,
  ...props
}: SearchInputProps) {
  return (
    <div className={cn('relative', containerClassName)}>
      <Icon
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground mobile:left-3"
        aria-hidden
      />
      {/* pl-8 clears the 10px inset + 16px glyph on desktop; mobile:pl-10 does
          the same for the 12px inset AND outranks the base mobile:px-4. */}
      <Input className={cn('pl-8 mobile:pl-10', className)} {...props} />
    </div>
  );
}
