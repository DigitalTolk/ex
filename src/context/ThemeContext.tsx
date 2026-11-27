import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { revealTheme } from '@/lib/theme-transition';
import { readString, writeString } from '@/lib/storage';

export type Theme = 'light' | 'dark' | 'system';

interface ThemeState {
  theme: Theme;
  // With `reveal`, a change between light and dark plays the dancing
  // gopher (lib/theme-transition).
  setTheme: (t: Theme, reveal?: boolean) => void;
}

const ThemeContext = createContext<ThemeState | undefined>(undefined);

// isDark is whether a theme setting draws the page dark now.
function isDark(theme: Theme): boolean {
  if (theme !== 'system') return theme === 'dark';
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', isDark(theme));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => (readString('theme') as Theme) || 'system');

  useEffect(() => {
    applyTheme(theme);
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (theme === 'system') applyTheme('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = (t: Theme, reveal = false) => {
    writeString('theme', t);
    // Only a change the eye can see is revealed: Light to "Match system" on
    // a light machine changes nothing on screen.
    if (!reveal || isDark(t) === document.documentElement.classList.contains('dark')) {
      setThemeState(t);
      return;
    }
    // The page must change inside the transition's callback, so the setting
    // renders now rather than on React's next pass.
    void revealTheme(() => {
      flushSync(() => setThemeState(t));
      applyTheme(t);
    });
  };

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

// Read-only fallback used when a consumer is rendered outside the
// ThemeProvider (e.g. isolated browser tests that mount a single
// component). Tracks the documentElement's `.dark` class so the UI
// at least observes the live theme even without a provider; setTheme
// is a no-op since there is nobody to persist into.
const fallbackTheme: ThemeState = {
  get theme(): Theme {
    /* istanbul ignore next -- SSR guard: this browser-only app always has document; the typeof===undefined arm is unreachable under test */
    if (typeof document === 'undefined') return 'system';
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  },
  setTheme: () => undefined,
};

export function useTheme() {
  return useContext(ThemeContext) ?? fallbackTheme;
}
