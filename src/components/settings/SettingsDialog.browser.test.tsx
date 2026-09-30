import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { useState } from 'react';
import { SettingsDialog } from './SettingsDialog';
import { SaveIndicator, SaveStatusProvider, SettingsRow, SettingsSection } from './settings-ui';
import { useSaveTracker } from './save-status';

// The pages have their own suites; here they're stubs so the dialog shell
// (nav, page switching, focus, save indicator) is tested on its own.
vi.mock('./ProfileSettings', () => ({ ProfileSettings: () => <p>profile-body</p> }));
vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => <p>appearance-body</p> }));
vi.mock('./NotificationsSettings', () => ({ NotificationsSettings: () => <p>notifications-body</p> }));

const authState = vi.hoisted(() => ({ user: { id: 'u-1' } as { id: string } | null }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => authState }));

describe('SettingsDialog', () => {
  beforeEach(() => {
    authState.user = { id: 'u-1' };
  });
  afterEach(() => cleanup());

  it('renders nothing when closed', async () => {
    await render(<SettingsDialog open={false} onOpenChange={vi.fn()} />);
    expect(document.querySelector('[data-testid="settings-dialog"]')).toBeNull();
  });

  it('renders nothing when signed out', async () => {
    authState.user = null;
    await render(<SettingsDialog open onOpenChange={vi.fn()} />);
    expect(document.querySelector('[data-testid="settings-dialog"]')).toBeNull();
  });

  it('opens on Profile by default and switches pages from the nav', async () => {
    const screen = await render(<SettingsDialog open onOpenChange={vi.fn()} />);
    await expect.element(screen.getByRole('heading', { name: 'Profile' })).toBeVisible();
    await expect.element(screen.getByText('profile-body')).toBeVisible();
    await expect.element(screen.getByTestId('settings-nav-profile')).toHaveAttribute('aria-current', 'page');

    await screen.getByTestId('settings-nav-appearance').click();
    await expect.element(screen.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await expect.element(screen.getByText('appearance-body')).toBeVisible();
    await expect.element(screen.getByTestId('settings-nav-appearance')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('settings-nav-profile').element().getAttribute('aria-current')).toBeNull();

    await screen.getByTestId('settings-nav-notifications').click();
    await expect.element(screen.getByText('notifications-body')).toBeVisible();
  });

  it('can open straight on a given page, with focus on the page (not the nav)', async () => {
    const screen = await render(<SettingsDialog open onOpenChange={vi.fn()} initialPage="notifications" />);
    await expect.element(screen.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('settings-page-notifications').element()));
  });

  it('closes from the close button', async () => {
    const onOpenChange = vi.fn();
    const screen = await render(<SettingsDialog open onOpenChange={onOpenChange} />);
    const close = window.innerWidth < 768 ? screen.getByRole('button', { name: 'Done' }) : screen.getByRole('button', { name: 'Close' });
    await close.click();
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });
});

// A tiny page that routes a controllable save through the tracker.
function SaveHarness() {
  const track = useSaveTracker();
  const [pending, setPending] = useState<{ resolve: () => void; reject: () => void }[]>([]);
  function start() {
    let resolve!: () => void;
    let reject!: () => void;
    const p = new Promise<void>((res, rej) => {
      resolve = res;
      reject = () => rej(new Error('x'));
    });
    track(p).catch(() => {});
    setPending((list) => [...list, { resolve, reject }]);
  }
  return (
    <div>
      <button type="button" onClick={start}>start</button>
      <button type="button" onClick={() => pending[0]?.resolve()}>resolve-0</button>
      <button type="button" onClick={() => pending[1]?.resolve()}>resolve-1</button>
      <button type="button" onClick={() => pending[pending.length - 1]?.reject()}>reject-last</button>
    </div>
  );
}

function statusEl() {
  return document.querySelector('[data-testid="settings-save-status"]') as HTMLElement;
}

describe('save status', () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('shows Saving… then Saved (only after the last pending save), then fades', async () => {
    const screen = await render(
      <SaveStatusProvider>
        <SaveHarness />
        <SaveIndicator />
      </SaveStatusProvider>,
    );
    expect(statusEl().dataset.state).toBe('idle');
    await screen.getByText('start').click();
    await screen.getByText('start').click();
    await vi.waitFor(() => expect(statusEl()).toHaveTextContent('Saving…'));
    await screen.getByText('resolve-0').click();
    // One save still in flight → still "Saving…".
    await new Promise((r) => setTimeout(r, 20));
    expect(statusEl().dataset.state).toBe('saving');
    await screen.getByText('resolve-1').click();
    await vi.waitFor(() => expect(statusEl()).toHaveTextContent('Saved'));
    await vi.waitFor(() => expect(statusEl().dataset.state).toBe('idle'), { timeout: 3000 });
  });

  it('flips to error (hidden) when a save fails', async () => {
    const screen = await render(
      <SaveStatusProvider>
        <SaveHarness />
        <SaveIndicator />
      </SaveStatusProvider>,
    );
    await screen.getByText('start').click();
    await screen.getByText('reject-last').click();
    await vi.waitFor(() => expect(statusEl().dataset.state).toBe('error'));
    expect(statusEl().className).toContain('opacity-0');
  });

  it('clears its fade timer on unmount', async () => {
    const screen = await render(
      <SaveStatusProvider>
        <SaveHarness />
        <SaveIndicator />
      </SaveStatusProvider>,
    );
    await screen.getByText('start').click();
    await screen.getByText('resolve-0').click();
    await vi.waitFor(() => expect(statusEl().dataset.state).toBe('saved'));
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    screen.unmount();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('the indicator renders idle outside a provider', async () => {
    await render(<SaveIndicator />);
    expect(statusEl().dataset.state).toBe('idle');
  });
});

describe('settings rows', () => {
  afterEach(() => cleanup());

  it('renders sections with and without a title, plain and stacked rows, and a footer', async () => {
    const screen = await render(
      <>
        <SettingsSection title="Group" footer={<p>footer-content</p>}>
          <SettingsRow label="Plain" testID="row-plain">
            <span>control</span>
          </SettingsRow>
          <SettingsRow label="Stacked" hint="A hint" htmlFor="x" stacked testID="row-stacked">
            <input id="x" />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection>
          <SettingsRow label="Untitled" />
        </SettingsSection>
      </>,
    );
    await expect.element(screen.getByRole('heading', { name: 'Group' })).toBeVisible();
    await expect.element(screen.getByText('footer-content')).toBeVisible();
    expect(screen.getByTestId('row-plain').element().className).toContain('justify-between');
    expect(screen.getByTestId('row-stacked').element().className).toContain('flex-col');
    await expect.element(screen.getByLabelText('Stacked')).toBeVisible();
    await expect.element(screen.getByText('A hint')).toBeVisible();
    await expect.element(screen.getByText('Untitled')).toBeVisible();
    // Only one titled section.
    expect(document.querySelectorAll('h3').length).toBe(1);
  });
});
