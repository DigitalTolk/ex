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
}

export function Banner({ tone, icon, children, actions, testId }: BannerProps) {
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
