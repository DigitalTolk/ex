import { useRef, useState, type ComponentType, type RefObject } from 'react';
import { Bell, Palette, User as UserIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/context/AuthContext';
import { AppearanceSettings } from './AppearanceSettings';
import { NotificationsSettings } from './NotificationsSettings';
import { ProfileSettings } from './ProfileSettings';
import { SaveIndicator, SaveStatusProvider } from './settings-ui';

export type SettingsPage = 'profile' | 'appearance' | 'notifications';

const PAGES: { key: SettingsPage; label: string; icon: ComponentType<{ className?: string }>; Body: ComponentType }[] = [
  { key: 'profile', label: 'Profile', icon: UserIcon, Body: ProfileSettings },
  { key: 'appearance', label: 'Appearance', icon: Palette, Body: AppearanceSettings },
  { key: 'notifications', label: 'Notifications', icon: Bell, Body: NotificationsSettings },
];

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPage?: SettingsPage;
}

// SettingsDialog is the single home for personal preferences: a left nav of
// pages (Profile, Appearance, Notifications), each a list of rows that save as
// soon as they change — there is no Save button, just a "Saved" indicator.
export function SettingsDialog({ open, onOpenChange, initialPage = 'profile' }: SettingsDialogProps) {
  const { user } = useAuth();
  // Land focus on the page (not the first nav item) so opening the dialog
  // doesn't draw a focus ring on an unselected tab; Tab still reaches the nav.
  const pageRef = useRef<HTMLDivElement>(null);
  if (!user) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="3xl"
        mobileCloseLabel="Done"
        finalFocus={false}
        initialFocus={() => pageRef.current}
        className="h-[min(640px,calc(100dvh-2rem))] grid-cols-[200px_minmax(0,1fr)] gap-0 overflow-hidden p-0 mobile:h-auto mobile:overflow-hidden mobile:grid-cols-1 mobile:grid-rows-[auto_minmax(0,1fr)] mobile:p-0"
        data-testid="settings-dialog"
      >
        {/* Remount per open so every page re-reads fresh server state. */}
        {open && <SettingsBody initialPage={initialPage} pageRef={pageRef} />}
      </DialogContent>
    </Dialog>
  );
}

function SettingsBody({ initialPage, pageRef }: { initialPage: SettingsPage; pageRef: RefObject<HTMLDivElement | null> }) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const current = PAGES.find((p) => p.key === page)!;
  const Body = current.Body;

  return (
    <SaveStatusProvider>
      <nav
        aria-label="Settings sections"
        className="border-r bg-sidebar px-2.5 py-5 mobile:border-r-0 mobile:border-b mobile:px-3 mobile:pt-[calc(env(safe-area-inset-top)+0.75rem)] mobile:pb-2"
      >
        <DialogTitle className="mx-2.5 mb-4 text-[15px] font-semibold mobile:mb-2 mobile:h-9 mobile:leading-9">
          Settings
        </DialogTitle>
        <div className="flex flex-col gap-0.5 mobile:flex-row mobile:overflow-x-auto">
          {PAGES.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setPage(key)}
              aria-current={page === key ? 'page' : undefined}
              data-testid={`settings-nav-${key}`}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                page === key
                  ? 'bg-sidebar-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </div>
      </nav>

      <div className="relative min-h-0 min-w-0">
        <div
          ref={pageRef}
          tabIndex={-1}
          className="h-full overflow-y-auto px-9 pt-7 pb-14 outline-none mobile:px-4 mobile:pt-5"
          data-testid={`settings-page-${page}`}
        >
          <h2 className="mb-6 pr-8 text-xl font-semibold">{current.label}</h2>
          {/* Keyed so switching pages remounts the body with fresh state. */}
          <Body key={page} />
        </div>
        <SaveIndicator />
      </div>
    </SaveStatusProvider>
  );
}
