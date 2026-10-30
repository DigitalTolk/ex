import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CircleAlert, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FIELD_CLASS } from '@/components/ui/field-class';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { UserAvatar } from '@/components/UserAvatar';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { useEmojiMap } from '@/hooks/useEmoji';
import { isKnownEmoji } from '@/lib/emoji-shortcodes';
import { BlockList } from '@/components/chat/blocks/MessageBlocks';
import { ViewDateField } from './ViewDateField';
import { useIsMobile } from '@/hooks/useIsMobile';
import { apiFetch } from '@/lib/api';
import { carryValues, firstProblem, isInput, maxLengthOf, seedValues, toWire, validateValues, type FormValues } from '@/lib/app-view-form';
import { showToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { closeAppView, replaceAppView } from '@/stores/app-view';
import type { AppView, AppViewEvent, Block, InputBlock, ViewSubmitResult } from '@/types';

const fieldID = (view: AppView, blockID: string) => `view-${view.id}-${blockID}`.replace(/[^A-Za-z0-9_-]/g, '_');

// AppViewDialog is an app's form (views.open): the app's fields drawn with
// ex's own inputs, checked here as the server will check them, and sent to
// the app on submit. The app answers by closing it, pointing at fields to
// fix, or showing its next step in place.
export default function AppViewDialog({ event }: { event: AppViewEvent }) {
  const { view, app } = event;
  const isMobile = useIsMobile();
  const [shown, setShown] = useState(view);
  const [values, setValues] = useState<FormValues>(() => seedValues(view));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // The app changed the form (views.update, or its next step): keep what
  // the person entered in the fields it kept.
  if (shown.hash !== view.hash) {
    setValues(carryValues(shown, view, values));
    setErrors({});
    setBanner(null);
    setShown(view);
  }

  const focusField = (blockID: string | undefined) => {
    if (!blockID) return;
    // After the errors render, so a screen reader reads the field with them.
    requestAnimationFrame(() => document.getElementById(fieldID(view, blockID))?.focus());
  };

  const setValue = (blockID: string, value: string) => {
    setValues((v) => ({ ...v, [blockID]: value }));
    if (errors[blockID]) setErrors(({ [blockID]: _, ...rest }) => rest);
  };

  const close = () => {
    // The server forgets the form; the person is done either way.
    void apiFetch(`/api/v1/views/${view.id}/close`, { method: 'POST' }).catch(() => {});
    closeAppView();
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
        setBanner(res.notice || "That didn't go through. Try again.");
        return;
      }
      if (res.notice) showToast(res.notice, res.failed ? 'error' : 'success');
      if (res.action === 'errors') {
        const found = res.errors ?? {};
        setErrors(found);
        focusField(firstProblem(view, found));
      } else if (res.action === 'update' && res.view) {
        replaceAppView(res.view);
      } else {
        closeAppView();
      }
    } catch (err) {
      setBanner(err instanceof Error && err.message ? err.message : "That didn't go through. Try again.");
    } finally {
      setPending(false);
    }
  };

  const submitLabel = view.submit?.text;
  const closeLabel = view.close?.text ?? 'Cancel';

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        size="lg"
        data-testid="app-view-dialog"
        mobileCloseLabel={closeLabel}
        mobileAction={isMobile && submitLabel ? { label: submitLabel, onClick: () => void submit(), disabled: pending } : undefined}
      >
        <DialogHeader className="gap-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground" data-testid="app-view-app">
            <AppIcon app={app} />
            <span className="truncate">{app.name}</span>
          </div>
          <DialogTitle className="text-lg leading-snug font-semibold">{view.title.text}</DialogTitle>
          <DialogDescription className="sr-only">A form from {app.name}</DialogDescription>
        </DialogHeader>

        <form ref={formRef} onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-5" data-testid="app-view-form">
          {segments(view.blocks).map((segment) =>
            Array.isArray(segment) ? (
              <BlockList key={segment[0].block_id} blocks={segment} />
            ) : (
              <ViewField
                key={segment.block_id}
                id={fieldID(view, segment.block_id)}
                block={segment}
                value={values[segment.block_id] ?? ''}
                error={errors[segment.block_id]}
                onChange={(v) => setValue(segment.block_id, v)}
                onSubmitShortcut={() => formRef.current?.requestSubmit()}
              />
            ),
          )}
          {banner && (
            <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="app-view-banner">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {banner}
            </p>
          )}
          {/* Enter in a one-line field submits; the button itself lives in
              the footer (or the phone's top bar). */}
          <button type="submit" hidden tabIndex={-1} aria-hidden disabled={!submitLabel} />
        </form>

        {!isMobile && (
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={close} data-testid="app-view-close">
              {closeLabel}
            </Button>
            {submitLabel && (
              <Button type="button" onClick={() => void submit()} disabled={pending} aria-busy={pending || undefined} className="relative" data-testid="app-view-submit">
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

// segments groups a form's blocks: each field on its own, and runs of other
// blocks together, drawn by the message block renderer.
function segments(blocks: AppView['blocks']): Array<InputBlock | Block[]> {
  const out: Array<InputBlock | Block[]> = [];
  for (const block of blocks) {
    if (isInput(block)) out.push(block);
    else {
      const last = out[out.length - 1];
      if (Array.isArray(last)) last.push(block);
      else out.push([block]);
    }
  }
  return out;
}

interface ViewFieldProps {
  id: string;
  block: InputBlock;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  onSubmitShortcut: () => void;
}

function ViewField({ id, block, value, error, onChange, onSubmitShortcut }: ViewFieldProps) {
  const el = block.element;
  const noteID = `${id}-note`;
  const note = error ?? block.hint?.text;
  const max = maxLengthOf(block);
  const length = [...value].length;
  const shared = { id, 'aria-invalid': !!error || undefined, 'aria-describedby': note ? noteID : undefined, 'data-testid': id };

  let control: ReactNode;
  if (el.type === 'plain_text_input' && el.multiline) {
    control = (
      <textarea
        {...shared}
        value={value}
        placeholder={el.placeholder?.text}
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
    );
  } else if (el.type === 'plain_text_input') {
    control = <Input {...shared} value={value} placeholder={el.placeholder?.text} onChange={(e) => onChange(e.target.value)} autoComplete="off" />;
  } else if (el.type === 'datepicker') {
    control = (
      <ViewDateField
        id={id}
        value={value}
        onChange={onChange}
        placeholder={el.placeholder?.text}
        clearable={!!block.optional}
        invalid={!!error}
        describedBy={note ? noteID : undefined}
      />
    );
  } else {
    control = (
      <NativeSelect
        {...shared}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(!value && '[&_select]:text-muted-foreground')}
      >
        <option value="" disabled={!block.optional}>
          {el.placeholder?.text ?? 'Choose…'}
        </option>
        {el.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.text.text}
          </option>
        ))}
      </NativeSelect>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={`view-field-${block.block_id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {block.label.text}
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
        <p id={noteID} className={cn('flex items-start gap-1.5 text-xs', error ? 'text-destructive' : 'text-muted-foreground')} data-testid={`${id}-note`}>
          {error && <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />}
          {note}
        </p>
      )}
    </div>
  );
}
