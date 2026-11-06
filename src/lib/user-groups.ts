import type { UserGroupLinkPreview } from '@/types/generated';

// linkSummary says what taking a group's members from a Microsoft 365 group
// will do.
export function linkSummary(preview: UserGroupLinkPreview): string {
  const parts = [`Adds ${preview.toAdd}`];
  if (preview.toRemove > 0) parts.push(`removes ${preview.toRemove}`);
  if (preview.skipped > 0) parts.push(`${preview.skipped} aren't in ex yet`);
  return parts.join(' · ');
}
