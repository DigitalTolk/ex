import type { ReactNode } from 'react';
import { usePageTitle } from '@/stores/page-title';

interface PageContainerProps {
  // Omitted: no header — the page heads itself (e.g. a tab bar).
  title?: string;
  // The name for the phone's top bar when `title` is omitted.
  mobileTitle?: string;
  description?: ReactNode;
  // Right-aligned slot in the header — actions, filters, etc.
  actions?: ReactNode;
  // On a phone the content runs edge to edge (a list of full-width
  // sections); the header keeps its inset.
  flush?: boolean;
  children: ReactNode;
}

// PageContainer is the shared shell for content pages (Threads, Drafts,
// Search, Directory, Admin, the AI hub). Their content sits in the same
// centred column as a conversation's messages, so every tab reads alike.
export function PageContainer({ title, mobileTitle, description, actions, flush = false, children }: PageContainerProps) {
  // On a phone the name sits in the top bar beside the back button.
  usePageTitle(title ?? mobileTitle);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-page-scroll="true" data-testid="page-container">
      <div className={`mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6 ${flush ? 'mobile:space-y-3 mobile:px-0' : ''}`}>
        {title && (
          <header
            className={`flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between ${flush ? 'mobile:px-4' : ''}`}
          >
            <div className="min-w-0">
              {/* Phone: shown in the top bar instead (still read here). */}
              <h1 className="text-xl leading-[150%] font-semibold mobile:sr-only">{title}</h1>
              {description && (
                <p className="mt-1 text-sm text-muted-foreground mobile:mt-0">{description}</p>
              )}
            </div>
            {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
          </header>
        )}
        {children}
      </div>
    </div>
  );
}
