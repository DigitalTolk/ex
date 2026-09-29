import { PageContainer } from '@/components/layout/PageContainer';
import { AgentsAdminPanel } from '@/components/admin/AgentsAdminPanel';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

// The Agents tab of the admin area: the WORKSPACE DEFAULT for each shared
// agent. Deliberately not on the Agents page — everything there edits the
// viewer's own settings, and the two look identical while doing opposite
// things, so an admin saving a card there could reasonably believe they had
// changed it for the team.
export default function AdminAgentsPage() {
  useDocumentTitle('Admin · Agents');
  return (
    <PageContainer
      title="Agents"
      description="Defaults every member inherits unless they set their own."
    >
      <AgentsAdminPanel />
    </PageContainer>
  );
}
