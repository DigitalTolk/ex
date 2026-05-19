import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { readString, writeString } from '@/lib/storage';

export type Theme = 'light' | 'dark' | 'system';

interface ThemeState {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeState | undefined>(undefined);

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else if (theme === 'light') root.classList.remove('dark');
  else {
    const dark =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : false;
    root.classList.toggle('dark', dark);
  }
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

  const setTheme = (t: Theme) => {
    writeString('theme', t);
    setThemeState(t);
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
    if (typeof document === 'undefined') return 'system';
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  },
  setTheme: () => undefined,
};

export function useTheme() {
  return useContext(ThemeContext) ?? fallbackTheme;
}
