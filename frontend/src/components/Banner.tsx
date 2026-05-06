import type { ReactNode } from 'react';

export type BannerTone = 'info' | 'warn';

const TONE_CLASSES: Record<BannerTone, string> = {
  info: 'border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-100',
  warn: 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100',
};

interface BannerProps {
  tone: BannerTone;
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  testId?: string;
  centered?: boolean;
}

export function Banner({ tone, icon, children, actions, testId, centered = false }: BannerProps) {
  if (centered) {
    return (
      <div
        role="alert"
        data-testid={testId}
        className={`grid shrink-0 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 border-b px-3 py-2 text-sm ${TONE_CLASSES[tone]}`}
      >
        <div className="flex justify-start">{icon}</div>
        <div className="min-w-0 text-center">
          <span className="truncate">{children}</span>
        </div>
        {actions ? <div className="flex items-center justify-end gap-2">{actions}</div> : <div />}
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid={testId}
      className={`flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-sm ${TONE_CLASSES[tone]}`}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span>{children}</span>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
