import { PageContainer } from '@/components/layout/PageContainer';
import { IncomingWebhooksPanel } from '@/components/admin/IncomingWebhooksPanel';
import { useAuth } from '@/context/AuthContext';
import { isGuest } from '@/lib/roles';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

// Full-page manager for incoming webhooks: anyone but a guest manages their
// own, an admin everyone's (the server decides which are listed).
export default function IncomingWebhooksPage() {
  useDocumentTitle('Incoming webhooks');
  const { user } = useAuth();

  if (isGuest(user?.systemRole)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <p className="text-sm text-muted-foreground">Not available to guests.</p>
      </div>
    );
  }

  return (
    <PageContainer title="Incoming webhooks">
      <IncomingWebhooksPanel />
    </PageContainer>
  );
}
