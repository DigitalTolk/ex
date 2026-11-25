import { PageContainer } from '@/components/layout/PageContainer';
import { AgentModelsCard } from '@/components/admin/AgentModelsCard';
import { AgentsAdminPanel } from '@/components/admin/AgentsAdminPanel';
import { RunnersInAppCard } from '@/components/admin/RunnersInAppCard';
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
      description="Defaults every member inherits unless they set their own, the models agents may run on, and where agents may run."
    >
      <AgentsAdminPanel />
      <AgentModelsCard />
      <RunnersInAppCard />
    </PageContainer>
  );
}
