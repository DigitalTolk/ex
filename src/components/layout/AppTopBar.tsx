import { useEffect } from 'react';
import { ArrowLeft, ArrowRight, ChevronLeft, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { SearchBar } from '@/components/SearchBar';
import { navigationApi, useHistoryTraversal } from '@/hooks/useHistoryTraversal';
import { useIsMobile } from '@/hooks/useIsMobile';
import { claimHistoryKeys, historyShortcuts, historyStepFor, type HistoryStep } from '@/lib/history-shortcut';
import { isApplePlatform } from '@/lib/platform';
import { usePageTitleStore } from '@/stores/page-title';

interface AppTopBarProps {
  onOpenChannels?: () => void;
  channelsButtonHidden?: boolean;
}

/**
 * Slim app-wide top bar — the global SearchBar centred between two equal side
 * columns. Back and Forward sit at the left, beside the sidebar. The mobile
 * menu button (left) opens the channels drawer; it stays in the AppLayout's
 * swipe handler hierarchy. The account menu lives at the bottom of the
 * sidebar (see AccountMenu).
 */
export function AppTopBar({ onOpenChannels, channelsButtonHidden }: AppTopBarProps) {
  const isMobile = useIsMobile();
  const pageTitle = usePageTitleStore((s) => s.title);
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
      // viewport regardless of how wide the left controls are — on EVERY tier. On the COMPACT tier
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
      className="grid h-12 mobile:flex mobile:h-14 w-full shrink-0 grid-cols-[1fr_minmax(0,36rem)_1fr] compact:grid-cols-[1fr_minmax(0,17rem)_1fr] items-center gap-2 border-b border-border bg-chat-top px-2 mobile:px-3 text-sidebar-foreground [-webkit-app-region:drag] [&_button,&_a,&_input]:[-webkit-app-region:no-drag]"
      data-testid="app-shell-header"
      data-app-chrome="true"
      // The global search field lives on this sidebar-coloured strip, so the
      // mobile keyboard background must match the sidebar, not the chat.
      data-keyboard-surface="sidebar"
    >
      {/* Both side columns are held at least as wide as the controls on the
          left (--top-bar-side, index.css), so the search stays centred. */}
      <div
        className="flex items-center gap-1 compact:justify-end not-mobile:min-w-(--top-bar-side)"
        data-topbar-left="true"
      >
        {!isMobile && <HistoryButtons />}
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
          aria-label={isMobile ? 'Back' : 'Open channels'}
          aria-hidden={channelsButtonHidden || undefined}
          tabIndex={channelsButtonHidden ? -1 : 0}
          className={`h-7 w-7 mobile:h-11 mobile:w-11 mobile:-ml-2 text-sidebar-foreground hover:bg-sidebar-accent lg:hidden ${
            channelsButtonHidden ? 'invisible' : ''
          }`}
        >
          {/* On a phone this goes back to the list, so it reads as a back
              chevron; on a narrow desktop window it opens the sidebar. */}
          <Menu className="h-4 w-4 mobile:hidden" />
          <ChevronLeft className="h-6 w-6 not-mobile:hidden" />
        </Button>
      </div>

      {/* Phone: search lives in the bottom tab bar; the page's name takes
          its place, in the same row as the back button. (The page keeps its
          own heading for screen readers.) */}
      <div className="min-w-0 w-full mobile:hidden">
        <SearchBar />
      </div>
      {isMobile && pageTitle && (
        <p
          className="min-w-0 flex-1 truncate text-xl leading-[150%] font-semibold text-foreground"
          aria-hidden="true"
          data-testid="mobile-page-title"
        >
          {pageTitle}
        </p>
      )}

      {/* Empty right column: balances the left one so the search stays centred. */}
      <div aria-hidden="true" className="not-mobile:min-w-(--top-bar-side)" />
    </header>
  );
}

// Disabled, an arrow only dims (no dark-mode chip: it would read as pressed).
// rounded-lg like the sidebar toggle beside them.
const HISTORY_BUTTON_CLASS = 'rounded-lg text-sidebar-foreground hover:bg-sidebar-accent dark:disabled:bg-transparent';

const APPLE = isApplePlatform(navigator.userAgent);
const SHORTCUTS = historyShortcuts(APPLE);

// Through the Navigation API — the same history canGoBack/canGoForward
// describe. window.history would walk the tab's joint session history, which
// also holds the entries of frames on the page (an HTML preview's).
function traverse(nav: Navigation, to: HistoryStep) {
  const { committed, finished } = to === 'back' ? nav.back() : nav.forward();
  // A traversal that is refused or overtaken rejects both; nothing to report.
  void Promise.allSettled([committed, finished]);
}

// The tab's history, Slack-style, from these buttons or the keyboard. Hidden
// where the browser can't say whether there is anywhere to go.
function HistoryButtons() {
  const { canGoBack, canGoForward } = useHistoryTraversal();
  // One listener for the bar's lifetime, reading where history can go at the
  // moment of the key press.
  useEffect(() => {
    const nav = navigationApi();
    if (!nav) return;
    const canStep = (to: HistoryStep) => (to === 'back' ? nav.canGoBack : nav.canGoForward);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const to = historyStepFor(e, APPLE);
      if (to === null) return;
      // A held chord steps once: its repeats would queue step after step
      // and, past the first page, hand the rest to the browser's own Back.
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      // Nowhere to go: the browser's own shortcut, if it has one, still runs.
      if (!canStep(to)) return;
      e.preventDefault();
      traverse(nav, to);
    };
    document.addEventListener('keydown', onKey);
    const release = claimHistoryKeys(canStep);
    return () => {
      document.removeEventListener('keydown', onKey);
      release();
    };
  }, []);
  const nav = navigationApi();
  if (!nav) return null;
  return (
    <>
      <TooltipIconButton
        label="Back"
        shortcut={SHORTCUTS.back}
        disabled={!canGoBack}
        onClick={() => traverse(nav, 'back')}
        size="icon-sm"
        className={HISTORY_BUTTON_CLASS}
        testId="history-back"
      >
        <ArrowLeft className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        label="Forward"
        shortcut={SHORTCUTS.forward}
        disabled={!canGoForward}
        onClick={() => traverse(nav, 'forward')}
        size="icon-sm"
        className={HISTORY_BUTTON_CLASS}
        testId="history-forward"
      >
        <ArrowRight className="size-4" />
      </TooltipIconButton>
    </>
  );
}
