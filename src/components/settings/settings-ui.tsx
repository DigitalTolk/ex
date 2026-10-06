import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { SaveStatusContext, type SaveState } from './save-status';

// Shared building blocks for the Settings dialog pages. The layout follows the
// "one setting per row" pattern: label + optional hint on the left, the
// control on the right. Dividers sit only BETWEEN rows of a group — never under
// a heading or after the last row — and whitespace separates groups.

export function SettingsSection({
  title,
  children,
  footer,
}: {
  title?: string;
  children: ReactNode;
  // Rendered after the rows, outside the divided list (no hairline above it).
  footer?: ReactNode;
}) {
  return (
    <section className="mb-10 last:mb-0">
      {title && <h3 className="mb-1 text-[13px] font-semibold">{title}</h3>}
      <div className="[&>*+*]:border-t [&>*+*]:border-divider">{children}</div>
      {footer}
    </section>
  );
}

interface SettingsRowProps {
  label: ReactNode;
  hint?: ReactNode;
  // id of the control, so the label is announced with it.
  htmlFor?: string;
  children?: ReactNode;
  // Stack the control under the label (used for wide controls like chips).
  stacked?: boolean;
  className?: string;
  testID?: string;
}

export function SettingsRow({ label, hint, htmlFor, children, stacked, className, testID }: SettingsRowProps) {
  const labelEl = htmlFor ? (
    <label htmlFor={htmlFor} className="font-medium">
      {label}
    </label>
  ) : (
    <div className="font-medium">{label}</div>
  );
  return (
    <div
      data-testid={testID}
      className={`py-[18px] ${
        stacked
          ? 'flex flex-col gap-2.5'
          : 'flex items-center justify-between gap-6 narrow:flex-wrap narrow:gap-3'
      } ${className ?? ''}`}
    >
      <div className="min-w-0">
        {labelEl}
        {hint && <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Save status

export function SaveStatusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SaveState>('idle');
  const pending = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const track = useCallback(<T,>(p: Promise<T>): Promise<T> => {
    pending.current += 1;
    clearTimeout(timer.current);
    setState('saving');
    return p.then(
      (v) => {
        pending.current -= 1;
        if (pending.current === 0) {
          setState('saved');
          timer.current = setTimeout(() => setState('idle'), 1500);
        }
        return v;
      },
      (err: unknown) => {
        pending.current -= 1;
        setState('error');
        throw err;
      },
    );
  }, []);

  return <SaveStatusContext.Provider value={{ state, track }}>{children}</SaveStatusContext.Provider>;
}

export function SaveIndicator() {
  const ctx = useContext(SaveStatusContext);
  const state = ctx?.state ?? 'idle';
  const visible = state === 'saving' || state === 'saved';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="settings-save-status"
      data-state={state}
      className={`pointer-events-none absolute right-5 bottom-4 inline-flex items-center gap-1.5 rounded-full border bg-popover px-3 py-1 text-[13px] text-muted-foreground transition-opacity duration-200 mobile:bottom-[calc(env(safe-area-inset-bottom)+1rem)] ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {state === 'saved' && <Check className="h-3.5 w-3.5 text-foreground" aria-hidden="true" />}
      {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : ''}
    </div>
  );
}
