import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { buttonVariants } from '@/components/ui/button';

interface ResourceErrorPageProps {
  resource: string;
  status: 403 | 500;
  homeHref?: string;
}

function title(resource: string, status: 403 | 500) {
  const label = `${resource[0].toUpperCase()}${resource.slice(1)}`;
  if (status === 403) return `${label} access denied`;
  return `${label} unavailable`;
}

export function ResourceErrorPage({ resource, status, homeHref = '/' }: ResourceErrorPageProps) {
  const Icon = status === 403 ? ShieldAlert : AlertTriangle;
  return (
    <div
      role="alert"
      data-testid={`resource-error-${status}`}
      className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center text-muted-foreground"
    >
      <Icon className="h-12 w-12 text-muted-foreground/60" aria-hidden="true" />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{title(resource, status)}</h1>
        <p className="text-sm">
          {status === 403
            ? `You do not have access to this ${resource}.`
            : `We could not load this ${resource}. Please try again later.`}
        </p>
      </div>
      <Link to={homeHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        Go home
      </Link>
    </div>
  );
}
