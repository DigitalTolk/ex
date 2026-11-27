import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useTheme, type Theme } from '@/context/ThemeContext';
import { preloadThemeReveal } from '@/lib/theme-transition';
import { useIsMobile } from '@/hooks/useIsMobile';
import { hasCustomPanelWidths, resetPanelWidths } from '@/lib/panel-width';
import { showToast } from '@/lib/toast';
import { setSidebarTheme, useSidebarThemeStore, type SidebarTheme } from '@/stores/sidebar-theme';
import { SettingsRow, SettingsSection } from './settings-ui';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match system' },
];

const SIDEBARS: { value: SidebarTheme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  const sidebarTheme = useSidebarThemeStore((s) => s.theme);
  const isMobile = useIsMobile();
  // Read on mount — the page remounts whenever it's opened.
  const [layoutCustomized, setLayoutCustomized] = useState(() => hasCustomPanelWidths());
  // The theme switch's dancing gopher (lib/theme-transition), fetched while
  // the page is open so the switch doesn't wait for it.
  useEffect(() => preloadThemeReveal(), []);

  function handleResetLayout() {
    resetPanelWidths();
    setLayoutCustomized(false);
    showToast('Panel widths reset', 'success');
  }

  return (
    <>
      <SettingsSection title="Theme">
        <div className="grid grid-cols-3 gap-3 pt-3 narrow:gap-2" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={theme === t.value}
              aria-label={`${t.label} theme`}
              onClick={() => setTheme(t.value, true)}
              className="group text-left outline-none"
              data-testid={`theme-option-${t.value}`}
            >
              <ThemePreview kind={t.value} selected={theme === t.value} />
              <span className="mt-2 block font-medium">{t.label}</span>
            </button>
          ))}
        </div>
      </SettingsSection>

      {/* The sidebar's own colours: a desktop choice (a phone's list follows
          the theme). */}
      {!isMobile && (
        <SettingsSection title="Sidebar">
          <div className="grid grid-cols-3 gap-3 pt-3 narrow:gap-2" role="radiogroup" aria-label="Sidebar">
            {SIDEBARS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={sidebarTheme === option.value}
                aria-label={`${option.label} sidebar`}
                onClick={() => setSidebarTheme(option.value)}
                className="group text-left outline-none"
                data-testid={`sidebar-theme-option-${option.value}`}
              >
                <PreviewFrame selected={sidebarTheme === option.value}>
                  <Mini p={PALETTE.light} side={option.value === 'dark' ? PALETTE.dark : PALETTE.light} />
                </PreviewFrame>
                <span className="mt-2 block font-medium">{option.label}</span>
              </button>
            ))}
          </div>
          <p className="pt-3 text-sm text-muted-foreground">
            Dark keeps the sidebar dark in the light theme too. In the dark theme it is always dark.
          </p>
        </SettingsSection>
      )}

      {/* Panel widths are a desktop affordance — mobile panels are full-width sheets. */}
      {!isMobile && (
        <SettingsSection title="Layout">
          <SettingsRow label="Panel widths" hint="Put the sidebar and side panels back to their default size.">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleResetLayout}
              disabled={!layoutCustomized}
              data-testid="reset-panel-widths"
            >
              Reset
            </Button>
          </SettingsRow>
        </SettingsSection>
      )}
    </>
  );
}

// Fixed-colour miniature of the app in each theme, so the cards look the same
// whichever theme is active (they preview the choice, not the current state).
const PALETTE = {
  light: { side: '#F9F9F7', main: '#FCFCFB', line: '#E3E3E2', bar: '#E3E3E2', strong: '#0B0B0B' },
  dark: { side: '#1D1D1D', main: '#1A1A1A', line: '#242424', bar: '#333333', strong: '#FFFFFF' },
};

// `side` paints the sidebar from another palette than the page's: the dark
// sidebar beside a light page.
function Mini({ p, side = p }: { p: (typeof PALETTE)['light']; side?: (typeof PALETTE)['light'] }) {
  return (
    <div className="absolute inset-0 grid grid-cols-[30%_70%]">
      <div className="flex flex-col gap-[5px] px-1.5 py-2.5" style={{ background: side.side, borderRight: `1px solid ${side.line}` }}>
        <div className="h-1.5 w-[70%] rounded-full" style={{ background: side.strong }} />
        <div className="h-1.5 rounded-full" style={{ background: side.bar }} />
        <div className="h-1.5 w-[80%] rounded-full" style={{ background: side.bar }} />
      </div>
      <div className="flex flex-col gap-1.5 px-2.5 py-3" style={{ background: p.main }}>
        <div className="h-1.5 w-[60%] rounded-full" style={{ background: p.bar }} />
        <div className="h-1.5 rounded-full" style={{ background: p.bar }} />
        <div className="h-1.5 w-[85%] rounded-full" style={{ background: p.bar }} />
      </div>
    </div>
  );
}

// The framed miniature a choice card shows, ringed while it is the choice.
function PreviewFrame({ selected, children }: { selected: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className={`relative h-[84px] overflow-hidden rounded-[10px] border transition-shadow narrow:h-16 ${
        selected
          ? 'border-transparent ring-2 ring-foreground'
          : 'group-hover:ring-2 group-hover:ring-border-strong group-focus-visible:ring-2 group-focus-visible:ring-foreground/60'
      }`}
    >
      {children}
    </div>
  );
}

function ThemePreview({ kind, selected }: { kind: Theme; selected: boolean }) {
  return (
    <PreviewFrame selected={selected}>
      {kind === 'dark' ? (
        <Mini p={PALETTE.dark} />
      ) : (
        <Mini p={PALETTE.light} />
      )}
      {kind === 'system' && (
        <div className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
          <Mini p={PALETTE.dark} />
        </div>
      )}
    </PreviewFrame>
  );
}
