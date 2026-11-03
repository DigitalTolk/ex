import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, CircleAlert, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FIELD_CLASS } from '@/components/ui/field-class';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { UserAvatar } from '@/components/UserAvatar';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { ActScope, BlockList } from '@/components/chat/blocks/MessageBlocks';
import type { ActValue } from '@/components/chat/blocks/blockScope';
import { ChoiceList } from './controls/ChoiceList';
import { MultiSelect } from './controls/MultiSelect';
import { TimeField } from './controls/TimeField';
import { UserPicker } from './controls/UserPicker';
import { ViewDateField } from './ViewDateField';
import { SentPanel } from './SentPanel';
import { clickOrigin } from '@/lib/app-clicks';
import { noteReceipt, useActionReceipts } from '@/stores/action-receipts';
import { useAuth } from '@/context/AuthContext';
import { useEmojiMap } from '@/hooks/useEmoji';
import { useIsMobile } from '@/hooks/useIsMobile';
import { apiFetch } from '@/lib/api';
import {
  carryValues,
  firstProblem,
  initialOf,
  maxLengthOf,
  seedValues,
  segments,
  sentAnswers,
  toWire,
  validateValues,
  type FormValue,
  type FormValues,
  type SentAnswer,
} from '@/lib/app-view-form';
import { isKnownEmoji } from '@/lib/emoji-shortcodes';
import { showToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { closeAppView, popAppView, pushAppView, readDraft, replaceAppView, saveDraft, useAppViewStore } from '@/stores/app-view';
import type { AppView, AppViewEvent, InputBlock, ViewSubmitResult } from '@/types';

const fieldID = (view: AppView, blockID: string) => `view-${view.id}-${blockID}`.replace(/[^A-Za-z0-9_-]/g, '_');

// A typed field tells the app once the person pauses, not per keystroke.
const TYPING_PAUSE_MS = 700;

const FAILED = "That didn't go through. Try again.";

// AppViewDialog is an app's form (views.open): the app's fields drawn with
// ex's own inputs, checked here as the server will check them, and sent to
// the app on submit. The app answers by closing it, pointing at fields to
// fix, showing its next step in place or on top (Back returns), and — for
// fields and buttons that send changes — by reshaping it as it is filled.
export default function AppViewDialog({ event, depth = 1 }: { event: AppViewEvent; depth?: number }) {
  const { view, app } = event;
  const isMobile = useIsMobile();
  const { user } = useAuth();
  const [shown, setShown] = useState(view);
  const [values, setValues] = useState<FormValues>(() => readDraft(view.id) ?? seedValues(view));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Sent and done: the dialog says so, with what was sent, until dismissed.
  const [sent, setSent] = useState<{
    notice?: string;
    answers: SentAnswer[];
  } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // The card the form was opened from: its line follows the form, by the
  // name of the form opened from it (not a later step pushed on top).
  const origin = clickOrigin(event.clickID);
  const clickID = event.clickID;
  const title = useAppViewStore((s) => s.stack[0]?.view.title.text) ?? view.title.text;
  useEffect(() => {
    if (depth !== 1 || !origin) return;
    // Once per click: coming Back to the first form isn't opening it again.
    if (useActionReceipts.getState().byMessage[origin.messageID]?.clickID === clickID) return;
    noteReceipt(origin.messageID, { text: `You opened “${title}”`, clickID });
  }, [depth, origin, title, clickID]);
  // The latest values, for changes sent from timers and block callbacks.
  const valuesRef = useRef(values);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // The app changed the form (views.update, or its next step): keep what
  // the person entered in the fields it kept.
  if (shown.hash !== view.hash) {
    setValues(carryValues(shown, view, values));
    setErrors({});
    setBanner(null);
    setShown(view);
  }

  useEffect(() => {
    valuesRef.current = values;
    saveDraft(view.id, values);
  }, [view.id, values]);
  useEffect(() => {
    const pendingTimers = timers.current;
    return () => pendingTimers.forEach(clearTimeout);
  }, []);

  const focusField = (blockID: string | undefined) => {
    if (!blockID) return;
    // After the errors render, so a screen reader reads the field with them.
    requestAnimationFrame(() => document.getElementById(fieldID(view, blockID))?.focus());
  };

  // act sends a change in the form — a field that sends changes, or a
  // button or picker in it — with the form as it stands.
  const act = useCallback(
    async (blockID: string, actionID: string, value?: ActValue) => {
      try {
        const res = await apiFetch<{ notice?: string; failed?: boolean }>(`/api/v1/views/${view.id}/actions`, {
          method: 'POST',
          body: JSON.stringify({
            blockID,
            actionID,
            ...(value !== undefined && { value }),
            values: toWire(view, valuesRef.current),
          }),
        });
        if (res.notice) showToast(res.notice, res.failed ? 'error' : 'success');
      } catch (err) {
        showToast(err instanceof Error && err.message ? err.message : FAILED);
      }
    },
    [view],
  );

  const setValue = (block: InputBlock, value: FormValue) => {
    setValues((v) => ({ ...v, [block.block_id]: value }));
    if (errors[block.block_id]) setErrors(({ [block.block_id]: _, ...rest }) => rest);
    if (!block.dispatch_action) return;
    const typed = ['plain_text_input', 'number_input', 'email_text_input', 'url_text_input'].includes(block.element.type);
    const fire = () => void act(block.block_id, block.element.action_id, value);
    clearTimeout(timers.current.get(block.block_id));
    if (typed) timers.current.set(block.block_id, setTimeout(fire, TYPING_PAUSE_MS));
    else fire();
  };

  const tellClosed = (all: boolean) => {
    // The server forgets the form (and tells the app, if it asked).
    void apiFetch(`/api/v1/views/${view.id}/close`, {
      method: 'POST',
      body: JSON.stringify({ all, values: toWire(view, values) }),
    }).catch(() => {});
  };
  const closeAll = () => {
    // A sent form is already closed on the server: nothing to tell.
    if (!sent) {
      tellClosed(true);
      if (origin) noteReceipt(origin.messageID, { text: `You closed “${title}” without sending`, clickID });
    }
    closeAppView();
  };
  const back = () => {
    tellClosed(false);
    popAppView();
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (pending) return;
    const problems = validateValues(view, values);
    if (problems) {
      setErrors(problems);
      focusField(firstProblem(view, problems));
      return;
    }
    setPending(true);
    setBanner(null);
    try {
      const res = await apiFetch<ViewSubmitResult>(`/api/v1/views/${view.id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ values: toWire(view, values) }),
      });
      if (res.action === 'keep') {
        setBanner(res.notice || FAILED);
        return;
      }
      const done = res.action === 'close' && (res.cleared || depth === 1);
      // A finished form shows the app's note in its confirmation instead.
      if (res.notice && !done) showToast(res.notice, res.failed ? 'error' : 'success');
      if (res.action === 'errors') {
        const found = res.errors ?? {};
        setErrors(found);
        focusField(firstProblem(view, found));
      } else if (res.action === 'update' && res.view) {
        replaceAppView(res.view);
      } else if (res.action === 'push' && res.view) {
        pushAppView(res.view);
      } else if (done) {
        const answers = sentAnswers(view, values);
        setSent({ notice: res.notice, answers });
        if (origin) noteReceipt(origin.messageID, { text: `You sent “${title}”`, notice: res.notice, details: { app: app.name, title, notice: res.notice, answers }, clickID });
      } else {
        popAppView();
      }
    } catch (err) {
      setBanner(err instanceof Error && err.message ? err.message : FAILED);
    } finally {
      setPending(false);
    }
  };

  const submitLabel = view.submit?.text;
  const closeLabel = depth > 1 ? 'Back' : (view.close?.text ?? 'Cancel');

  return (
    <Dialog open onOpenChange={(open) => !open && closeAll()}>
      <DialogContent
        size="lg"
        data-testid="app-view-dialog"
        mobileCloseLabel={sent ? 'Close' : closeLabel}
        mobileAction={
          isMobile && sent
            ? { label: 'Done', onClick: closeAppView }
            : isMobile && submitLabel
              ? {
                  label: submitLabel,
                  onClick: () => void submit(),
                  disabled: pending,
                }
              : undefined
        }
      >
        <DialogHeader className="gap-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground" data-testid="app-view-app">
            {/* A sent form is done: there is no step to go back to. */}
            {depth > 1 && !sent && (
              <Button type="button" size="icon-xs" variant="ghost" onClick={back} aria-label="Back" className="-ml-1" data-testid="app-view-back">
                <ArrowLeft aria-hidden />
              </Button>
            )}
            <AppIcon app={app} />
            <span className="truncate">{app.name}</span>
          </div>
          <DialogTitle className="text-lg leading-snug font-semibold">{view.title.text}</DialogTitle>
          <DialogDescription className="sr-only">A form from {app.name}</DialogDescription>
        </DialogHeader>

        {sent ? (
          <SentPanel app={app.name} notice={sent.notice} answers={sent.answers} />
        ) : (
          <ActScope act={act} idPrefix={`view-${view.id}`} currentUserId={user?.id}>
            <form ref={formRef} onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-5" data-testid="app-view-form">
              {segments(view.blocks).map((segment) =>
                Array.isArray(segment) ? (
                  <BlockList key={segment[0].block_id} blocks={segment} />
                ) : (
                  <ViewField
                    key={segment.block_id}
                    id={fieldID(view, segment.block_id)}
                    block={segment}
                    value={values[segment.block_id] ?? initialOf(segment.element)}
                    error={errors[segment.block_id]}
                    onChange={(v) => setValue(segment, v)}
                    onSubmitShortcut={() => formRef.current?.requestSubmit()}
                  />
                ),
              )}
              {banner && (
                <p
                  className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                  data-testid="app-view-banner"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {banner}
                </p>
              )}
              {/* Enter in a one-line field submits; the button itself lives in
                the footer (or the phone's top bar). */}
              <button type="submit" hidden tabIndex={-1} aria-hidden disabled={!submitLabel} />
            </form>
          </ActScope>
        )}

        {!isMobile && sent && (
          <DialogFooter>
            <Button type="button" onClick={closeAppView} autoFocus data-testid="app-view-done">
              Done
            </Button>
          </DialogFooter>
        )}
        {!isMobile && !sent && (
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={depth > 1 ? back : closeAll} data-testid="app-view-close">
              {closeLabel}
            </Button>
            {submitLabel && (
              <Button
                type="button"
                onClick={() => void submit()}
                disabled={pending}
                aria-busy={pending || undefined}
                className="relative"
                data-testid="app-view-submit"
              >
                <span className={cn(pending && 'invisible')}>{submitLabel}</span>
                {pending && <Loader2 className="absolute animate-spin" aria-label="Sending" />}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// AppIcon is the app as its message showed it: its emoji icon when ex can
// draw it, else its picture or initials.
function AppIcon({ app }: { app: AppViewEvent['app'] }) {
  const { data: emojiMap } = useEmojiMap();
  if (app.iconEmoji && isKnownEmoji(app.iconEmoji, emojiMap)) {
    return (
      <span className="flex size-5 items-center justify-center" aria-hidden data-testid="app-view-icon">
        <EmojiGlyph emoji={`:${app.iconEmoji}:`} customMap={emojiMap} size="md" />
      </span>
    );
  }
  return <UserAvatar displayName={app.name} avatarURL={app.avatarURL} className="size-5" initialsClassName="text-xs" />;
}

interface ViewFieldProps {
  id: string;
  block: InputBlock;
  value: FormValue;
  error?: string;
  onChange: (value: FormValue) => void;
  onSubmitShortcut: () => void;
}

const asText = (v: FormValue) => (Array.isArray(v) ? (v[0] ?? '') : v);
const asList = (v: FormValue) => (Array.isArray(v) ? v : v ? [v] : []);

// ViewField is one field of a form, drawn with ex's own inputs (also the
// webhooks panel's form preview).
export function ViewField({ id, block, value, error, onChange, onSubmitShortcut }: ViewFieldProps) {
  const el = block.element;
  const noteID = `${id}-note`;
  const note = error ?? block.hint?.text;
  const label = block.label.text;
  const max = maxLengthOf(block);
  const text = asText(value);
  const length = [...text].length;
  const described = note ? noteID : undefined;
  const shared = {
    id,
    'aria-invalid': !!error || undefined,
    'aria-describedby': described,
    'data-testid': id,
  };
  const placeholder = 'placeholder' in el ? el.placeholder?.text : undefined;

  let control: ReactNode;
  switch (el.type) {
    case 'plain_text_input':
      control = el.multiline ? (
        <textarea
          {...shared}
          value={text}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          // ⌘/Ctrl+Enter sends a multi-line field's form; Enter is a new line.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmitShortcut();
            }
          }}
          rows={3}
          className={cn(FIELD_CLASS, 'h-auto max-h-64 min-h-20 resize-y py-2 leading-relaxed field-sizing-content mobile:h-auto mobile:py-2.5')}
        />
      ) : (
        <Input {...shared} value={text} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
      );
      break;
    case 'number_input':
      control = (
        <Input
          {...shared}
          value={text}
          placeholder={placeholder}
          inputMode={el.is_decimal_allowed ? 'decimal' : 'numeric'}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          className="tabular-nums"
        />
      );
      break;
    case 'email_text_input':
    case 'url_text_input':
      control = (
        <Input
          {...shared}
          type={el.type === 'email_text_input' ? 'email' : 'url'}
          value={text}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={el.type === 'email_text_input' ? 'email' : 'url'}
        />
      );
      break;
    case 'datepicker':
      control = (
        <ViewDateField
          id={id}
          value={text}
          onChange={onChange}
          placeholder={placeholder}
          clearable={!!block.optional}
          invalid={!!error}
          describedBy={described}
        />
      );
      break;
    case 'timepicker':
      control = <TimeField id={id} value={text} onChange={onChange} invalid={!!error} describedBy={described} label={label} />;
      break;
    case 'static_select':
      control = (
        <NativeSelect {...shared} value={text} onChange={(e) => onChange(e.target.value)} className={cn(!text && '[&_select]:text-muted-foreground')}>
          <option value="" disabled={!block.optional}>
            {placeholder ?? 'Choose…'}
          </option>
          {el.options.map((o) => (
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
          options={el.options}
          value={asList(value)}
          onChange={onChange}
          placeholder={placeholder}
          max={el.max_selected_items}
          invalid={!!error}
          describedBy={described}
        />
      );
      break;
    case 'checkboxes':
    case 'radio_buttons':
      control = (
        <ChoiceList
          id={id}
          label={label}
          options={el.options}
          multiple={el.type === 'checkboxes'}
          value={asList(value)}
          // A radio group always reports the one button picked.
          onChange={(next) => onChange(el.type === 'checkboxes' ? next : next[0])}
          invalid={!!error}
          describedBy={described}
        />
      );
      break;
    case 'users_select':
    case 'multi_users_select':
      control = (
        <UserPicker
          id={id}
          label={label}
          value={asList(value)}
          onChange={(next) => onChange(el.type === 'multi_users_select' ? next : (next[0] ?? ''))}
          multiple={el.type === 'multi_users_select'}
          max={el.type === 'multi_users_select' ? el.max_selected_items : undefined}
          placeholder={placeholder}
          invalid={!!error}
          describedBy={described}
        />
      );
      break;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={`view-field-${block.block_id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
          {block.optional && <span className="ml-1.5 text-xs font-normal text-muted-foreground">Optional</span>}
        </label>
        {/* The count shows as the limit nears, not as noise on every field. */}
        {max !== undefined && length >= max * 0.8 && (
          <span className={cn('shrink-0 text-xs tabular-nums text-muted-foreground', length > max && 'text-destructive')} data-testid={`${id}-count`}>
            {length}/{max}
          </span>
        )}
      </div>
      {control}
      {note && (
        <p
          id={noteID}
          className={cn('flex items-start gap-1.5 text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
          data-testid={`${id}-note`}
        >
          {error && <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />}
          {note}
        </p>
      )}
    </div>
  );
}
