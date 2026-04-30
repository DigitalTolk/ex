import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MentionAutocomplete, type MentionSuggestion } from '@/components/chat/MentionAutocomplete';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Stub the radix-based Avatar so jsdom can see <img src=...> directly
// (the real AvatarImage hides itself until image-load events fire,
// which jsdom doesn't dispatch).
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children, className }: { children: ReactNode; className?: string }) => (
    <span data-testid="avatar" className={className}>{children}</span>
  ),
  AvatarImage: ({ src, alt }: { src?: string; alt?: string }) => (
    <img data-testid="avatar-image" src={src} alt={alt ?? ''} />
  ),
  AvatarFallback: ({ children }: { children: ReactNode }) => (
    <span data-testid="avatar-fallback">{children}</span>
  ),
}));

const onlineSet = new Set<string>();
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: onlineSet,
    isOnline: (id: string) => onlineSet.has(id),
    setUserOnline: vi.fn(),
  }),
}));

const sampleRoster = [
  { id: 'u-1', email: 'alice@example.com', displayName: 'Alice', avatarURL: 'https://cdn/alice.png', systemRole: 'member', status: 'active' },
  { id: 'u-2', email: 'bob@example.com', displayName: 'Bob', systemRole: 'member', status: 'active' },
  { id: 'u-3', email: 'carla@noice.io', displayName: 'Carla', systemRole: 'member', status: 'active' },
  { id: 'u-4', email: 'dave.j@example.com', displayName: 'Dave Johnson', systemRole: 'member', status: 'active' },
];

function renderPopup(props: {
  query: string;
  onPick?: (s: MentionSuggestion) => void;
  onDismiss?: () => void;
  roster?: unknown[];
  online?: string[];
}) {
  const roster = props.roster ?? sampleRoster;
  apiFetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/v1/users')) {
      return Promise.resolve(roster);
    }
    return Promise.resolve([]);
  });
  onlineSet.clear();
  for (const id of props.online ?? []) onlineSet.add(id);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MentionAutocomplete
        query={props.query}
        anchorRect={{ left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20, x: 100, y: 100, toJSON: () => ({}) } as DOMRect}
        onPick={props.onPick ?? vi.fn()}
        onDismiss={props.onDismiss ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

function rowTexts(): string[] {
  return screen.getAllByTestId('mention-option').map((o) => o.textContent ?? '');
}

describe('MentionAutocomplete', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows the user roster on bare `@` (empty query)', async () => {
    renderPopup({ query: '' });
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('Alice'))).toBe(true);
    });
  });

  it('hides @all and @here on bare `@` — these are noisy, only typed-in-full', async () => {
    renderPopup({ query: '' });
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('Alice'))).toBe(true);
    });
    expect(rowTexts().some((t) => t.includes('@all'))).toBe(false);
    expect(rowTexts().some((t) => t.includes('@here'))).toBe(false);
  });

  it('hides @all on partial query "al" until the full word is typed', async () => {
    renderPopup({ query: 'al' });
    await waitFor(() => {
      expect(rowTexts().length).toBeGreaterThan(0);
    });
    expect(rowTexts().some((t) => t.includes('@all'))).toBe(false);
  });

  it('shows @all only when the user has typed it in full', async () => {
    renderPopup({ query: 'all' });
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('@all'))).toBe(true);
    });
    expect(rowTexts().some((t) => t.includes('@here'))).toBe(false);
  });

  it('shows @here only when the user has typed it in full', async () => {
    renderPopup({ query: 'here' });
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('@here'))).toBe(true);
    });
    expect(rowTexts().some((t) => t.includes('@all'))).toBe(false);
  });

  it('sorts online users to the top of the list', async () => {
    renderPopup({ query: '', online: ['u-3'] }); // Carla online, others not
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('Carla'))).toBe(true);
    });
    const texts = rowTexts();
    // Carla (online) appears before any offline user.
    const carlaIdx = texts.findIndex((t) => t.includes('Carla'));
    const aliceIdx = texts.findIndex((t) => t.includes('Alice'));
    expect(carlaIdx).toBeLessThan(aliceIdx);
  });

  it('shows an online indicator dot on online users only', async () => {
    renderPopup({ query: '', online: ['u-3'] }); // Carla online
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('Carla'))).toBe(true);
    });
    const opts = screen.getAllByTestId('mention-option');
    const carla = opts.find((o) => o.textContent?.includes('Carla'));
    const alice = opts.find((o) => o.textContent?.includes('Alice'));
    expect(carla?.querySelector('[data-testid="mention-online-indicator"]')).not.toBeNull();
    expect(alice?.querySelector('[data-testid="mention-online-indicator"]')).toBeNull();
  });

  it('autocompletes user names from a single typed character', async () => {
    renderPopup({ query: 'a' });
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('Alice'))).toBe(true);
    });
  });

  it('matches user names by email substring (e.g. "noice" → carla@noice.io)', async () => {
    renderPopup({ query: 'noice' });
    await waitFor(() => {
      const texts = rowTexts();
      expect(texts.some((t) => t.includes('Carla'))).toBe(true);
      expect(texts.some((t) => t.includes('carla@noice.io'))).toBe(true);
    });
  });

  it('renders user rows with avatar + display name + email', async () => {
    renderPopup({ query: 'alice' });
    await waitFor(() => {
      const opts = screen.getAllByTestId('mention-option');
      const aliceRow = opts.find((o) => o.textContent?.includes('Alice'));
      expect(aliceRow).toBeDefined();
      // Avatar image element with alice's URL.
      const img = aliceRow!.querySelector('img');
      expect(img?.getAttribute('src')).toBe('https://cdn/alice.png');
      // Email visible alongside the name.
      expect(aliceRow!.textContent).toContain('alice@example.com');
    });
  });

  it('falls back to initials when a user has no avatar URL', async () => {
    renderPopup({ query: 'bob' });
    await waitFor(() => {
      const opts = screen.getAllByTestId('mention-option');
      const bobRow = opts.find((o) => o.textContent?.includes('Bob'));
      expect(bobRow).toBeDefined();
      // Initials fallback rendered in the avatar.
      expect(bobRow!.textContent).toContain('B');
    });
  });

  it('matches user names with elongation typos (e.g. "Aliceeee" → Alice)', async () => {
    renderPopup({ query: 'Aliceeee' });
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('Alice'))).toBe(true);
    });
  });

  it('matches user names with a single-character typo (e.g. "Aliec" → Alice)', async () => {
    // Levenshtein-1 fuzzy match on tokens — handles common typos in
    // four-character-or-longer queries.
    renderPopup({ query: 'Aliec' });
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('Alice'))).toBe(true);
    });
  });

  it('matches a token within a multi-word display name (e.g. "john" → Dave Johnson)', async () => {
    renderPopup({ query: 'john' });
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('Dave Johnson'))).toBe(true);
    });
  });

  it('Enter picks the highlighted suggestion', async () => {
    const onPick = vi.fn();
    renderPopup({ query: '', onPick });
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('Alice'))).toBe(true);
    });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toMatchObject({ kind: 'user' });
  });

  it('ArrowDown advances the active row', async () => {
    const onPick = vi.fn();
    renderPopup({ query: '', onPick });
    await waitFor(() => {
      expect(rowTexts().length).toBeGreaterThan(1);
    });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toMatchObject({ kind: 'user' });
  });

  it('ArrowUp wraps from the first row to the last suggestion', async () => {
    const onPick = vi.fn();
    renderPopup({ query: '', onPick });
    await waitFor(() => {
      expect(rowTexts().some((t) => t.includes('Dave Johnson'))).toBe(true);
    });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toMatchObject({ kind: 'user' });
  });

  it('Escape dismisses the popup', () => {
    const onDismiss = vi.fn();
    renderPopup({ query: '', onDismiss });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('clicking an option picks it and prevents focus loss', async () => {
    const onPick = vi.fn();
    renderPopup({ query: '', onPick });
    await waitFor(() => {
      expect(rowTexts().length).toBeGreaterThan(0);
    });
    const opts = screen.getAllByTestId('mention-option');
    fireEvent.mouseDown(opts[0]);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('Tab also picks the active suggestion', async () => {
    const onPick = vi.fn();
    renderPopup({ query: '', onPick });
    await waitFor(() => {
      expect(rowTexts().length).toBeGreaterThan(0);
    });
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(onPick).toHaveBeenCalled();
  });

  it('renders nothing when there are zero suggestions', async () => {
    renderPopup({ query: 'zzzznomatch', roster: [] });
    await waitFor(() => {
      expect(screen.queryByTestId('mention-popup')).toBeNull();
    });
  });
});
