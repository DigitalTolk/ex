import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeCard, UiLibraryCard } from '@/components/projects/DesignSystemCards';
import type { ProjectDetail } from '@/hooks/useProjects';

type ApiInit = { method?: string; body?: string };
const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));

let patches: unknown[];
let fail: unknown;
beforeEach(() => {
  patches = [];
  fail = null;
  showToast.mockReset();
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation(async (_path, init) => {
    if (fail) throw fail;
    patches.push(JSON.parse(init!.body!));
    return { project: {} };
  });
});

function detail(over: Partial<ProjectDetail> = {}, uiLibrary?: string): ProjectDetail {
  return {
    canManage: true,
    screens: [],
    project: { key: 'acme', name: 'Acme', repos: [], createdBy: 'u', createdAt: '', updatedAt: '', uiLibrary },
    ...over,
  };
}

function renderCard(el: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
}

describe('UiLibraryCard', () => {
  it('saves the library and reports failures', async () => {
    renderCard(<UiLibraryCard detail={detail({}, 'Bootstrap')} />);
    const input = screen.getByRole('combobox', { name: 'UI library' });
    expect(input).toHaveValue('Bootstrap');
    const save = screen.getByRole('button', { name: 'Save library' });
    expect(save).toBeDisabled();
    expect(document.querySelectorAll('#ui-library-suggestions option').length).toBeGreaterThan(5);
    fireEvent.change(input, { target: { value: 'shadcn/ui' } });
    fireEvent.click(save);
    await waitFor(() => expect(patches).toEqual([{ uiLibrary: 'shadcn/ui' }]));
    expect(showToast).toHaveBeenCalledWith('UI library saved', 'success');
    fail = new Error('too long');
    fireEvent.click(save);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('too long'));
    fail = 'odd';
    fireEvent.click(save);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not save the UI library'));
  });

  it('starts empty without a saved library', () => {
    renderCard(<UiLibraryCard detail={detail()} />);
    expect(screen.getByRole('combobox', { name: 'UI library' })).toHaveValue('');
  });
});

describe('ThemeCard', () => {
  it('uploads a stylesheet file', async () => {
    renderCard(<ThemeCard detail={detail()} />);
    const input = screen.getByTestId('theme-file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: /Upload CSS/ }));
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [new File([':root{--a:1}'], 'globals.css', { type: 'text/css' })] } });
    await waitFor(() => expect(patches).toEqual([{ themeCSS: ':root{--a:1}', themeFilename: 'globals.css' }]));
    expect(showToast).toHaveBeenCalledWith('Theme saved', 'success');
    fireEvent.change(input, { target: { files: [] } });
    expect(patches).toHaveLength(1);
  });

  it('pastes a stylesheet instead, and can cancel', async () => {
    renderCard(<ThemeCard detail={detail()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Paste instead' }));
    const save = screen.getByRole('button', { name: 'Save theme' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Paste stylesheet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Paste instead' }));
    fireEvent.change(screen.getByLabelText('Paste stylesheet'), { target: { value: ':root{--b:2}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }));
    await waitFor(() => expect(patches).toEqual([{ themeCSS: ':root{--b:2}', themeFilename: 'pasted.css' }]));
    await waitFor(() => expect(screen.queryByLabelText('Paste stylesheet')).not.toBeInTheDocument());
  });

  it('shows the saved theme as the agent sees it, and removes it', async () => {
    renderCard(
      <ThemeCard
        detail={detail({
          theme: { filename: 'globals.css', size: 36900, variables: 72, summary: ':root\n  --a: 1', updatedBy: 'u', updatedAt: new Date().toISOString() },
        })}
      />,
    );
    const card = screen.getByTestId('theme-card');
    expect(card).toHaveTextContent('globals.css');
    expect(card).toHaveTextContent('72 variables');
    expect(within(card).getByText(/What the agent gets/)).toBeInTheDocument();
    expect(within(card).getByText(/--a: 1/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /Replace/ })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Paste instead' })).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Remove theme CSS' }));
    await waitFor(() => expect(patches).toEqual([{ themeCSS: '', themeFilename: '' }]));
    expect(showToast).toHaveBeenCalledWith('Theme removed', 'success');
  });

  it('reports a refused stylesheet', async () => {
    renderCard(<ThemeCard detail={detail()} />);
    fail = new Error('no CSS variables found');
    fireEvent.change(screen.getByTestId('theme-file-input'), { target: { files: [new File(['body{}'], 'x.css')] } });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('no CSS variables found'));
    fail = 'odd';
    fireEvent.change(screen.getByTestId('theme-file-input'), { target: { files: [new File(['body{}'], 'x.css')] } });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not save the theme'));
  });
});
