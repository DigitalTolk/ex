import type { MobileNotificationLevel, NotificationLevel, NotificationSettings } from '@/types';

export interface NotificationOption {
  value: string;
  label: string;
}

// The account-level defaults applied when a user has never customised settings,
// mirroring the backend DefaultNotificationSettings(). Both notification dialogs
// fall back to this when user.notificationSettings is undefined.
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  desktopLevel: 'mentions',
  mobileLevel: 'default',
  threadReplies: true,
  ignoreGroupMentions: false,
  followAllThreads: false,
  keywords: [],
};

// The notification-level option rows, defined once so the two dialogs and their
// "Default: …" hints all read from one source. The per-channel dialog prepends
// INHERIT_OPTION to offer "use my account default".
export const INHERIT_OPTION: NotificationOption = { value: 'inherit', label: 'Use default' };
export const DESKTOP_LEVEL_OPTIONS: NotificationOption[] = [
  { value: 'all', label: 'All messages' },
  { value: 'mentions', label: 'Mentions, DMs & keywords' },
];
export const MOBILE_LEVEL_OPTIONS: NotificationOption[] = [
  { value: 'default', label: 'Same as desktop' },
  ...DESKTOP_LEVEL_OPTIONS,
];

// Value→label records for branch-free "Default: …" hint lookups, derived once
// at module load from the option arrays above (single source of truth).
function labelMap(options: NotificationOption[]): Record<string, string> {
  return Object.fromEntries(options.map((o) => [o.value, o.label]));
}
export const DESKTOP_LEVEL_LABEL = labelMap(DESKTOP_LEVEL_OPTIONS) as Record<NotificationLevel, string>;
export const MOBILE_LEVEL_LABEL = labelMap(MOBILE_LEVEL_OPTIONS) as Record<MobileNotificationLevel, string>;
