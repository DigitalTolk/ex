import { PageContainer } from '@/components/layout/PageContainer';
import { BotsPanel } from '@/components/admin/BotsPanel';
import { useAuth } from '@/context/AuthContext';
import { isAdmin } from '@/lib/roles';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

// Admin manager for bot accounts: create bots, issue/revoke exbot_ tokens, and
// point external bots at an outgoing-webhook URL. Cliffy shows up as an internal
// bot (it's a real bot_cliffy account) but is wired in code — its in-process
// handler takes precedence, so a webhook set here wouldn't change its behavior.
export default function BotsPage() {
  useDocumentTitle('Bots');
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
      title="Bots"
      description="Create bot accounts, issue access tokens, and connect external bots via outgoing webhooks."
    >
      <BotsPanel />
    </PageContainer>
  );
}
