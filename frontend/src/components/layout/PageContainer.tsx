import type { ReactNode } from 'react';

interface PageContainerProps {
  title: string;
  description?: string;
  // Right-aligned slot in the header — actions, filters, etc.
  actions?: ReactNode;
  children: ReactNode;
}

// PageContainer is the shared shell for full-width content pages
// (Directory, Threads, New conversation, Admin). All four used to set
// their own max-width caps and padding; this component keeps the shape
// consistent and uses the full content width.
export function PageContainer({ title, description, actions, children }: PageContainerProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-page-scroll="true" data-testid="page-container">
      <div className="space-y-6 p-4 sm:p-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-bold">{title}</h1>
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}
