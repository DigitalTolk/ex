import { PageContainer } from '@/components/layout/PageContainer';
import { CustomEmojiDescription, CustomEmojiManager } from '@/components/emoji/CustomEmojiManager';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

// The /emojis page. The account menu opens the same manager as a pop-up
// (CustomEmojiDialog); this route stays so existing links keep working.
export default function CustomEmojiPage() {
  useDocumentTitle('Custom emojis');
  return (
    <PageContainer title="Custom emojis" description={<CustomEmojiDescription />}>
      <CustomEmojiManager />
    </PageContainer>
  );
}
