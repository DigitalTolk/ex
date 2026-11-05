import { PageContainer } from '@/components/layout/PageContainer';
import { BotsPanel } from '@/components/admin/BotsPanel';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

// The Bots tab of the admin area: bot accounts and their access tokens.
export default function AdminBotsPage() {
  useDocumentTitle('Admin · Bots');
  return (
    <PageContainer title="Bots">
      <BotsPanel />
    </PageContainer>
  );
}
