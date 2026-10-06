import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchBar } from '@/components/SearchBar';

interface AppTopBarProps {
  onOpenChannels?: () => void;
  channelsButtonHidden?: boolean;
}

/**
 * Slim app-wide top bar — the global SearchBar centred between two equal side
 * columns. The mobile menu button (left) opens the channels drawer; it stays
 * in the AppLayout's swipe handler hierarchy. The account menu lives at the
 * bottom of the sidebar (see AccountMenu).
 */
export function AppTopBar({ onOpenChannels, channelsButtonHidden }: AppTopBarProps) {
  return (
    <header
      // Compact macOS title-bar strip on desktop (36px tall, minimal
      // horizontal padding). On mobile the touch targets and the
      // 36px search field need breathing room, so the strip grows
      // to 48px and gains a hair more horizontal padding — without
      // it the search input clips against the bottom border. The
      // strip is draggable-as-a-titlebar on native via Capacitor
      // (carve-outs cover the interactive children).
      // Equal 1fr side columns keep the search field centred in the
      // viewport regardless of how wide the left (channels) control is — on EVERY tier. On the COMPACT tier
      // (narrow desktop window) the field stays centred but its column
      // caps at 17rem instead of 36rem, and the hamburger docks against
      // the field's LEFT edge (justify-end on the left column) instead of
      // sitting at the window edge — so macOS traffic lights on a
      // frameless window can never cover it, detection or not; the
      // top-left corner stays pure draggable titlebar. (An earlier `auto`
      // first column glued the search to the left edge; the field must
      // stay centred at every width.) The .electron-mac padding remains
      // as the safety net for windows squeezed to the column's minimum,
      // and the grid shifts the field off-centre rather than burying the
      // toggle when side minimums no longer fit.
      className="grid h-12 mobile:h-14 w-full shrink-0 grid-cols-[1fr_minmax(0,36rem)_1fr] compact:grid-cols-[1fr_minmax(0,17rem)_1fr] items-center gap-2 border-b border-border bg-chat-top px-2 mobile:px-3 text-sidebar-foreground [-webkit-app-region:drag] [&_button,&_a,&_input]:[-webkit-app-region:no-drag]"
      data-testid="app-shell-header"
      data-app-chrome="true"
      // The global search field lives on this sidebar-coloured strip, so the
      // mobile keyboard background must match the sidebar, not the chat.
      data-keyboard-surface="sidebar"
    >
      <div className="flex items-center compact:justify-end" data-topbar-left="true">
        {/* The hamburger shows whenever the channel sidebar isn't already
            open (mobile drawer closed, or tablet md–lg which has no
            permanent sidebar). When it should be hidden — drawer open, or
            the home/start page where the channel list is the main view —
            we keep it mounted but `invisible` so the column's box never
            changes width and the centred search bar can't shift/resize.
            It's dropped only on desktop (lg+) where the sidebar is
            permanent. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenChannels}
          aria-label="Open channels"
          aria-hidden={channelsButtonHidden || undefined}
          tabIndex={channelsButtonHidden ? -1 : 0}
          className={`h-7 w-7 text-sidebar-foreground hover:bg-sidebar-accent lg:hidden ${
            channelsButtonHidden ? 'invisible' : ''
          }`}
        >
          <Menu className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-w-0 w-full">
        <SearchBar />
      </div>

      {/* Empty right column: balances the left one so the search stays centred. */}
      <div aria-hidden="true" />
    </header>
  );
}
