import { renderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import type { BlockText, SelectOption } from '@/types';

const OptionText = ({ text }: { text: BlockText }) =>
  text.type === 'markdown' ? <span className="prose-message [&_p]:my-0">{renderMarkdown(text.text)}</span> : <span>{text.text}</span>;

interface ChoiceListProps {
  id: string;
  label: string;
  options: SelectOption[];
  // Checkboxes hold several values; radio buttons one.
  multiple: boolean;
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

// ChoiceList is a group of checkboxes or radio buttons, each with its text
// and an optional second line. Native inputs keep keyboard and screen-reader
// behaviour exact (arrow keys move within a radio group).
export function ChoiceList({ id, label, options, multiple, value, onChange, disabled, invalid, describedBy }: ChoiceListProps) {
  const toggle = (v: string, checked: boolean) => {
    if (!multiple) onChange([v]);
    else onChange(checked ? [...value, v] : value.filter((x) => x !== v));
  };
  return (
    <div
      id={id}
      role={multiple ? 'group' : 'radiogroup'}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className="flex flex-col gap-1"
      data-testid={id}
    >
      {options.map((o, i) => {
        const optionID = `${id}-${i}`;
        return (
          <label
            key={o.value}
            htmlFor={optionID}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1 text-sm hover:bg-muted mobile:min-h-11 mobile:py-2',
              disabled && 'pointer-events-none opacity-50',
            )}
          >
            <input
              id={optionID}
              type={multiple ? 'checkbox' : 'radio'}
              name={id}
              value={o.value}
              checked={value.includes(o.value)}
              disabled={disabled}
              onChange={(e) => toggle(o.value, e.target.checked)}
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary mobile:size-5"
            />
            <span className="flex min-w-0 flex-col">
              <OptionText text={o.text} />
              {o.description && (
                <span className="text-xs text-muted-foreground">
                  <OptionText text={o.description} />
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
