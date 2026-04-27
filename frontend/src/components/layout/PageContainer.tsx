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
    <div className="flex-1 overflow-y-auto" data-testid="page-container">
      <div className="p-6 space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold">{title}</h1>
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}
