import { useRef, useState } from 'react';
import { ExternalLink, Loader2, MoreHorizontal } from 'lucide-react';
import { ChoiceList } from '@/components/apps/controls/ChoiceList';
import { MultiSelect } from '@/components/apps/controls/MultiSelect';
import { TimeField } from '@/components/apps/controls/TimeField';
import { UserPicker } from '@/components/apps/controls/UserPicker';
import { ViewDateField } from '@/components/apps/ViewDateField';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { NativeSelect } from '@/components/ui/native-select';
import { externalHref } from '@/lib/url-safety';
import { formatDay } from '@/lib/app-view-form';
import { cn } from '@/lib/utils';
import type { PickerElement, SelectOption } from '@/types';
import { elementDomID, useBlockScope, type ActValue } from './blockScope';

const initialOf = (el: PickerElement): string[] => {
  switch (el.type) {
    case 'static_select':
    case 'radio_buttons':
      return el.initial_option ? [el.initial_option.value] : [];
    case 'multi_static_select':
    case 'checkboxes':
      return el.initial_options?.map((o) => o.value) ?? [];
    case 'datepicker':
      return el.initial_date ? [el.initial_date] : [];
    case 'timepicker':
      return el.initial_time ? [el.initial_time] : [];
    case 'users_select':
      return el.initial_user ? [el.initial_user] : [];
    case 'overflow':
      return [];
  }
};

const isList = (el: PickerElement) => el.type === 'multi_static_select' || el.type === 'checkboxes';

// describe says in words what was picked, for the line under the card.
function describe(el: PickerElement, next: string[], name?: string): string {
  // An option by its text; a value the app started with but doesn't list, as is.
  const quote = (options: SelectOption[], v: string) => `“${options.find((o) => o.value === v)?.text.text ?? v}”`;
  switch (el.type) {
    case 'multi_static_select':
    case 'checkboxes':
      return next.length ? `You chose ${next.map((v) => quote(el.options, v)).join(', ')}` : 'You cleared your choices';
    case 'datepicker':
      return `You picked ${formatDay(next[0])}`;
    case 'timepicker':
      return `You picked ${next[0]}`;
    case 'users_select':
      /* v8 ignore next -- a person is only ever picked from the search list, which names them; the fallback is defensive */
      /* istanbul ignore next -- a person is only ever picked from the search list, which names them; the fallback is defensive */
      return `You picked ${name ?? 'someone'}`;
    case 'static_select':
    case 'radio_buttons':
    case 'overflow':
      return `You chose ${quote(el.options, next[0])}`;
  }
}

// BlockPicker is an element that picks a value — a select, a ⋯ menu, a date
// or time, checkboxes, radio buttons, a person — in a message's actions row
// or accessory, or a form's. Using it sends what was picked to the app (after
// its confirm dialog, if it has one); the server checks the value against
// the stored element before the app sees it.
export function BlockPicker({ blockID, element }: { blockID: string; element: PickerElement }) {
  const scope = useBlockScope();
  const [value, setValue] = useState<string[]>(() => initialOf(element));
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<{ next: string[]; prev: string[] } | null>(null);
  // The confirm dialog closes after a confirm too: this tells that close
  // (which keeps the new choice) from a cancel (which puts the old one back).
  const confirmed = useRef(false);
  const live = !!scope?.interactive && !!scope.appButtons;
  const id = elementDomID(scope, blockID, element.action_id);
  const label = 'placeholder' in element && element.placeholder ? element.placeholder.text : 'Choose';

  const [pickedName, setPickedName] = useState<string>();

  const send = async (next: string[], name = pickedName) => {
    /* v8 ignore next -- the element is disabled outside a live scope, so nothing is sent without one */
    /* istanbul ignore next -- the element is disabled outside a live scope, so nothing is sent without one */
    if (!scope) return;
    setPending(true);
    const v: ActValue = isList(element) ? next : next[0];
    await scope.act(blockID, element.action_id, v, describe(element, next, name));
    setPending(false);
  };

  const pick = (next: string[], name?: string) => {
    const prev = value;
    setValue(next);
    setPickedName(name);
    if (element.confirm) setConfirming({ next, prev });
    else void send(next, name);
  };

  let control;
  switch (element.type) {
    case 'static_select':
      control = (
        <NativeSelect
          id={id}
          size="sm"
          value={value[0] ?? ''}
          disabled={!live || pending}
          aria-label={label}
          onChange={(e) => pick([e.target.value])}
          className={cn('w-auto max-w-full', !value[0] && '[&_select]:text-muted-foreground')}
          data-testid={id}
        >
          <option value="" disabled>
            {element.placeholder?.text ?? 'Choose…'}
          </option>
          {element.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.text.text}
            </option>
          ))}
        </NativeSelect>
      );
      break;
    case 'multi_static_select':
      control = (
        <MultiSelect
          id={id}
          label={label}
          options={element.options}
          value={value}
          onChange={pick}
          placeholder={element.placeholder?.text}
          max={element.max_selected_items}
          applyLabel="Apply"
          size="sm"
          disabled={!live || pending}
        />
      );
      break;
    case 'overflow':
      control = (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" size="icon-sm" variant="outline" aria-label="More options" disabled={!live || pending} data-testid={id} />}
          >
            <MoreHorizontal aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {element.options.map((o) =>
              o.url ? (
                <DropdownMenuItem key={o.value} render={<a href={externalHref(o.url)} target="_blank" rel="noreferrer" />}>
                  <span className="flex-1 truncate">{o.text.text}</span>
                  <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden />
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={o.value} onClick={() => pick([o.value])} data-testid={`${id}-${o.value}`}>
                  {o.text.text}
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      );
      break;
    case 'datepicker':
      control = (
        <ViewDateField
          id={id}
          value={value[0] ?? ''}
          onChange={(v) => v && pick([v])}
          placeholder={element.placeholder?.text}
          clearable={false}
          invalid={false}
          size="sm"
          disabled={!live || pending}
          label={label}
        />
      );
      break;
    case 'timepicker':
      control = (
        <TimeField id={id} value={value[0] ?? ''} onChange={(v) => v && pick([v])} commitOnBlur size="sm" disabled={!live || pending} label={label} />
      );
      break;
    case 'checkboxes':
    case 'radio_buttons':
      control = (
        <ChoiceList
          id={id}
          label={label}
          options={element.options}
          multiple={element.type === 'checkboxes'}
          value={value}
          onChange={pick}
          disabled={!live || pending}
        />
      );
      break;
    case 'users_select':
      control = (
        <UserPicker
          id={id}
          label={label}
          value={value}
          onChange={(next, name) => next.length && pick(next, name)}
          placeholder={element.placeholder?.text}
          size="sm"
          disabled={!live || pending}
        />
      );
      break;
  }

  return (
    <span
      className={cn('relative inline-flex max-w-full', pending && 'opacity-70')}
      aria-busy={pending || undefined}
      title={scope?.interactive && !scope.appButtons ? "This app isn't set up for buttons" : undefined}
      data-testid={`block-picker-${element.action_id}`}
    >
      {control}
      {pending && <Loader2 className="absolute -top-1.5 -right-1.5 size-3.5 animate-spin text-muted-foreground" aria-label="Sending" />}
      {confirming && element.confirm && (
        <ConfirmDialog
          open
          onOpenChange={() => {
            // Closed without confirming (Keep it, Escape): the old choice comes back.
            if (!confirmed.current) setValue(confirming.prev);
            confirmed.current = false;
            setConfirming(null);
          }}
          title={element.confirm.title.text}
          description={element.confirm.text.text}
          confirmLabel={element.confirm.confirm.text}
          cancelLabel={element.confirm.deny.text}
          onConfirm={() => {
            confirmed.current = true;
            void send(confirming.next);
          }}
          testIDPrefix="block-confirm"
        />
      )}
    </span>
  );
}
