import { Link } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';

interface NotFoundPageProps {
  // What the user was looking for — "channel", "conversation",
  // "page". Tweaks the heading copy.
  resource?: string;
  // Where "Go home" lands — defaults to root.
  homeHref?: string;
}

export function NotFoundPage({ resource = 'page', homeHref = '/' }: NotFoundPageProps) {
  return (
    <div
      role="alert"
      data-testid="not-found-page"
      className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center text-muted-foreground"
    >
      <FileQuestion className="h-12 w-12 text-muted-foreground/60" aria-hidden="true" />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">
          {resource === 'page' ? 'Page not found' : `${resource[0].toUpperCase()}${resource.slice(1)} not found`}
        </h1>
        <p className="text-sm">
          The {resource} you're looking for doesn't exist.
        </p>
      </div>
      <Link to={homeHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        Go home
      </Link>
    </div>
  );
}
