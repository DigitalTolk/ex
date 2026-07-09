import { PageContainer } from '@/components/layout/PageContainer';
import { IncomingWebhooksPanel } from '@/components/admin/IncomingWebhooksPanel';
import { useAuth } from '@/context/AuthContext';
import { isAdmin } from '@/lib/roles';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

// Full-page manager for incoming webhooks, split out of the workspace
// settings page so it has room to grow (per-webhook controls, usage, etc.).
export default function IncomingWebhooksPage() {
  useDocumentTitle('Incoming webhooks');
  const { user } = useAuth();

  if (!isAdmin(user?.systemRole)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <p className="text-sm text-muted-foreground">Admin access required.</p>
      </div>
    );
  }

  return (
    <PageContainer
      title="Incoming webhooks"
      description="Mattermost-compatible webhook URLs that post messages into channels."
    >
      <IncomingWebhooksPanel />
    </PageContainer>
  );
}
