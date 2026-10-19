import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScreensTab } from '@/components/projects/ScreensTab';
import type { ScreenView } from '@/hooks/useProjects';

type ApiInit = { method?: string; body?: string };
const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));
const uploadAttachment = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAttachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAttachments')>()),
  uploadAttachment,
}));
vi.mock('@/lib/project-screens', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/project-screens')>()),
  readImageSize: async (f: File) => (f.name.includes('phone') ? { width: 390, height: 844 } : { width: 1440, height: 900 }),
}));

const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function screenFixtures(): ScreenView[] {
  return [
    {
      id: 's1', projectKey: 'acme', page: 'Home', description: 'Landing page', viewport: 'desktop', attachmentID: 'a1',
      uploadedBy: 'u-2', createdAt: iso(1), updatedAt: iso(1), imageURL: '/m/a1', thumbnailURL: '/t/a1', width: 1440, height: 900,
    },
    {
      id: 's2', projectKey: 'acme', page: 'Home', description: 'Landing on a phone', viewport: 'mobile', state: 'empty',
      seenBy: 'admin', route: '/home', attachmentID: 'a2', uploadedBy: 'u-9', createdAt: iso(200), updatedAt: iso(200),
    },
    {
      id: 's3', projectKey: 'acme', page: 'Settings', description: 'Prefs', viewport: 'desktop', attachmentID: 'a3',
      uploadedBy: 'u-2', createdAt: iso(3), updatedAt: iso(3), imageURL: '/m/a3',
    },
  ];
}

let calls: { path: string; init?: ApiInit }[];
let failNext: unknown;

beforeEach(() => {
  calls = [];
  failNext = undefined;
  mockApiFetch.mockReset();
  showToast.mockReset();
  uploadAttachment.mockReset();
  uploadAttachment.mockImplementation(async (f: File) => ({ id: 'up-' + f.name }));
  mockApiFetch.mockImplementation(async (path, init) => {
    if (path === '/api/v1/users/batch') return [{ id: 'u-2', displayName: 'Bob', email: 'b@example.com', systemRole: 'member' }];
    calls.push({ path, init });
    if (failNext) {
      const e = failNext;
      failNext = undefined;
      throw e;
    }
    return { screen: {} };
  });
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: (f: File) => 'blob:' + f.name, revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderTab(screens: ScreenView[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScreensTab projectKey="acme" screens={screens} />
    </QueryClientProvider>,
  );
}

const png = (name: string) => new File(['x'], name, { type: 'image/png' });

describe('ScreensTab drafts', () => {
  it('turns chosen images into labelled drafts and saves one', async () => {
    renderTab();
    expect(screen.getByTestId('screens-empty')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('screens-file-input'), {
      target: { files: [png('booking-detail.png'), png('home-phone.png'), new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });
    const drafts = await screen.findAllByTestId('screen-draft');
    expect(drafts).toHaveLength(2);
    expect(showToast).toHaveBeenCalledWith('Only images can be reference screens.');
    const first = within(drafts[0]);
    expect(first.getByLabelText('Page name')).toHaveValue('Booking detail');
    expect(first.getByLabelText('Viewport')).toHaveValue('desktop');
    expect(within(drafts[1]).getByLabelText('Viewport')).toHaveValue('mobile');

    const save = first.getByRole('button', { name: 'Save screen' });
    expect(save).toBeDisabled();
    fireEvent.change(first.getByLabelText(/What this page is for/), { target: { value: ' One booking ' } });
    fireEvent.change(first.getByLabelText('State (optional)'), { target: { value: 'default' } });
    fireEvent.change(first.getByLabelText('Seen by (optional)'), { target: { value: 'admin' } });
    fireEvent.change(first.getByLabelText('Route (optional)'), { target: { value: '/b/:id' } });
    fireEvent.change(first.getByLabelText('Viewport'), { target: { value: 'mobile' } });
    fireEvent.change(first.getByLabelText('Page name'), { target: { value: 'Booking' } });
    fireEvent.click(save);
    await waitFor(() => expect(screen.getAllByTestId('screen-draft')).toHaveLength(1));
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(calls[0].path).toBe('/api/v1/projects/acme/screens');
    expect(JSON.parse(calls[0].init!.body!)).toEqual({
      page: 'Booking', description: 'One booking', viewport: 'mobile', state: 'default', seenBy: 'admin', route: '/b/:id',
      attachmentID: 'up-booking-detail.png',
    });
  });

  it('saves all ready drafts at once, keeps failures with their error, and discards', async () => {
    renderTab();
    fireEvent.change(screen.getByTestId('screens-file-input'), { target: { files: [png('a.png'), png('b.png'), png('c.png')] } });
    const drafts = await screen.findAllByTestId('screen-draft');
    for (const d of drafts) fireEvent.change(within(d).getByLabelText(/What this page is for/), { target: { value: 'desc' } });
    uploadAttachment.mockImplementation(async (f: File) => {
      if (f.name === 'b.png') throw new Error('upload broke');
      if (f.name === 'c.png') throw 'weird';
      return { id: 'up-' + f.name };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save all' }));
    await waitFor(() => expect(screen.getAllByTestId('screen-draft')).toHaveLength(2));
    expect(screen.getByText('upload broke')).toBeInTheDocument();
    expect(screen.getByText('Upload failed')).toBeInTheDocument();
    fireEvent.click(within(screen.getAllByTestId('screen-draft')[0]).getByRole('button', { name: 'Discard' }));
    expect(screen.getAllByTestId('screen-draft')).toHaveLength(1);
  });

  it('accepts dropped and pasted screenshots', async () => {
    const { unmount } = renderTab();
    const zone = screen.getByTestId('screens-dropzone');
    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [png('dropped.png')] } });
    expect(await screen.findAllByTestId('screen-draft')).toHaveLength(1);
    const paste = new Event('paste') as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', { value: { files: [png('pasted.png')] } });
    await act(async () => {
      window.dispatchEvent(paste);
    });
    await waitFor(() => expect(screen.getAllByTestId('screen-draft')).toHaveLength(2));
    const empty = new Event('paste') as ClipboardEvent;
    Object.defineProperty(empty, 'clipboardData', { value: null });
    await act(async () => {
      window.dispatchEvent(empty);
    });
    expect(screen.getAllByTestId('screen-draft')).toHaveLength(2);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('opens the file picker from the link, and ignores an empty pick', async () => {
    renderTab();
    const input = screen.getByTestId('screens-file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'choose files' }));
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: null } });
    await act(async () => {});
    expect(screen.queryByTestId('screen-draft')).not.toBeInTheDocument();
  });
});

describe('ScreensTab gallery', () => {
  it('groups screens by page with labels and freshness', async () => {
    renderTab(screenFixtures());
    expect(screen.getByRole('region', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument();
    const s2 = screen.getByTestId('screen-s2');
    expect(s2).toHaveTextContent('State: empty');
    expect(s2).toHaveTextContent('Seen by: admin');
    expect(s2).toHaveTextContent('/home');
    expect(s2).toHaveTextContent('May be outdated · Someone');
    expect(within(s2).getByText('Image unavailable')).toBeInTheDocument();
    expect(await within(screen.getByTestId('screen-s1')).findByText(/Bob ·/)).toBeInTheDocument();
    expect(screen.getByTestId('screen-s3').querySelector('img')).toHaveAttribute('src', '/m/a3');
  });

  it('views a screen full size', async () => {
    renderTab(screenFixtures());
    fireEvent.click(screen.getByRole('button', { name: 'View Home (desktop)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'Landing page' })).toHaveAttribute('src', '/m/a1');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'View Home (mobile)' }));
    expect(within(await screen.findByRole('dialog')).queryByRole('img')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'View Settings (desktop)' }));
    const img = within(await screen.findByRole('dialog')).getByRole('img', { name: 'Prefs' });
    expect(img).not.toHaveAttribute('width');
  });

  it('edits labels, shows a failed save, and cancels', async () => {
    renderTab(screenFixtures());
    const card = within(screen.getByTestId('screen-s2'));
    fireEvent.click(card.getByRole('button', { name: 'Edit labels' }));
    fireEvent.change(card.getByLabelText(/What this page is for/), { target: { value: 'Phone landing' } });
    failNext = new Error('bad');
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    expect(await card.findByRole('alert')).toHaveTextContent('Save failed: bad.');
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(card.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
    const patch = calls.filter((c) => c.init?.method === 'PATCH').at(-1)!;
    expect(patch.path).toBe('/api/v1/projects/acme/screens/s2');
    expect(JSON.parse(patch.init!.body!)).toMatchObject({ description: 'Phone landing', viewport: 'mobile', state: 'empty' });

    fireEvent.click(card.getByRole('button', { name: 'Edit labels' }));
    failNext = 'odd';
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    expect(await card.findByRole('alert')).toHaveTextContent(/^Save failed\.$/);
    fireEvent.click(card.getByRole('button', { name: 'Cancel' }));
    expect(card.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('replaces a screenshot and reports failures', async () => {
    renderTab(screenFixtures());
    const input = screen.getByTestId('screen-replace-s1') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(within(screen.getByTestId('screen-s1')).getByRole('button', { name: 'Replace screenshot' }));
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [png('new.png')] } });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Screenshot replaced', 'success'));
    expect(JSON.parse(calls.at(-1)!.init!.body!)).toEqual({ attachmentID: 'up-new.png' });

    uploadAttachment.mockRejectedValueOnce(new Error('too big'));
    fireEvent.change(input, { target: { files: [png('big.png')] } });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('too big'));
    uploadAttachment.mockRejectedValueOnce('weird');
    fireEvent.change(input, { target: { files: [png('odd.png')] } });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Replace failed'));
    fireEvent.change(input, { target: { files: [] } });
  });

  it('deletes a screen after confirming and toasts failures', async () => {
    renderTab(screenFixtures());
    const card = within(screen.getByTestId('screen-s3'));
    fireEvent.click(card.getByRole('button', { name: 'Delete screen' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete screen' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'DELETE' && c.path.endsWith('/screens/s3'))).toBe(true));

    failNext = new Error('gone');
    fireEvent.click(card.getByRole('button', { name: 'Delete screen' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete screen' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('gone'));
    failNext = 'odd';
    fireEvent.click(card.getByRole('button', { name: 'Delete screen' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete screen' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Delete failed'));
  });
});
