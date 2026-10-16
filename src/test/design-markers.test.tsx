import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DesignMarkers } from '@/components/projects/DesignMarkers';

type ApiInit = { method?: string; body?: string };
const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));

let notes = 'Font: Figtree';
let failPatch: unknown = null;
let screens: { attachmentID: string; imageURL?: string }[] = [];
let patches: unknown[] = [];
let pngWidth: number | undefined = 1440;

beforeEach(() => {
  notes = 'Font: Figtree';
  failPatch = null;
  patches = [];
  pngWidth = 1440;
  screens = [{ attachmentID: 'REF', imageURL: '/m/ref' }];
  showToast.mockReset();
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation(async (path, init) => {
    if (init?.method === 'PATCH') {
      if (failPatch) throw failPatch;
      const body = JSON.parse(init.body!);
      patches.push(body);
      notes = body.designNotes;
      return { project: {} };
    }
    if (path === '/api/v1/projects/cliffhub') {
      return { canManage: false, project: { key: 'cliffhub', name: 'CliffHub', repos: [], designNotes: notes }, screens };
    }
    if (path.startsWith('/api/v1/attachments?')) {
      return [
        { id: 'html', contentType: 'text/html', url: '/m/html', filename: 'v1.html' },
        { id: 'png', contentType: 'image/png', url: '/m/png', filename: 'v1.png', width: pngWidth, height: 900 },
      ];
    }
    throw new Error('unexpected ' + path);
  });
});

function renderMarkers(body: string, ids: string[] = ['html', 'png'], where: { channelId?: string; conversationId?: string } = { channelId: 'c1' }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DesignMarkers body={body} attachmentIDs={ids} messageID="m1" {...where} />
    </QueryClientProvider>,
  );
}

describe('DesignMarkers', () => {
  it('renders nothing without markers', () => {
    const { container } = renderMarkers('<!-- ex:something else -->');
    expect(container).toBeEmptyDOMElement();
  });

  it('compares the real page with the mockup on a slider', async () => {
    renderMarkers('v1\n<!-- ex:before cliffhub/REF -->', ['html', 'png'], { conversationId: 'd1' });
    fireEvent.click(screen.getByRole('button', { name: 'Compare with the real page' }));
    const dialog = await screen.findByRole('dialog');
    const before = await within(dialog).findByRole('img', { name: 'Real page' });
    expect(before).toHaveAttribute('src', '/m/ref');
    expect(within(dialog).getByRole('img', { name: 'Mockup' })).toHaveAttribute('src', '/m/png');
    // The stage takes the mockup's own proportions.
    expect(dialog.querySelector('[data-slot="image-comparison"]')).toHaveStyle({ aspectRatio: '1440 / 900' });
    const divider = within(dialog).getByRole('slider', { name: 'Real page and mockup divider' });
    expect(divider).toHaveAttribute('aria-valuenow', '50');
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(divider).toHaveAttribute('aria-valuenow', '52');
    expect(within(dialog).getByText('Drag the divider, or focus it and use the arrow keys.')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Side by side' }));
    const side = within(dialog).getByTestId('compare-side-by-side');
    expect(within(side).getByRole('img', { name: 'Real page' })).toHaveAttribute('src', '/m/ref');
    expect(within(side).getByRole('img', { name: 'Mockup' })).toHaveAttribute('src', '/m/png');
    expect(within(dialog).getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Slide' }));
    expect(within(dialog).getByRole('slider')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('says so when the reference screen is gone, and waits while loading', async () => {
    screens = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DesignMarkers body={'v1\n<!-- ex:before cliffhub/REF -->'} messageID="m1" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Compare with the real page' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('compare-loading')).toHaveTextContent('Loading both images');
    expect(await within(dialog).findByText('The reference screen is no longer on the project.')).toBeInTheDocument();
  });

  it('saves a suggested rule into the design notes once', async () => {
    renderMarkers('v2\n<!-- ex:design-note cliffhub | Corner radius is 4px -->');
    const card = await screen.findByTestId('design-note-suggestion');
    expect(await within(card).findByText('Suggested design note for CliffHub')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Add to design notes' }));
    await waitFor(() => expect(patches).toEqual([{ designNotes: 'Font: Figtree\n\nLearned from feedback:\n- Corner radius is 4px' }]));
    expect(showToast).toHaveBeenCalledWith('Added to design notes', 'success');
    expect(await within(card).findByText('In design notes')).toBeInTheDocument();
  });

  it('toasts a failed save and can be dismissed', async () => {
    renderMarkers('<!-- ex:design-note cliffhub | Rule one -->\n<!-- ex:design-note cliffhub | Rule two -->');
    const [first, second] = await screen.findAllByTestId('design-note-suggestion');
    await within(first).findByText('Suggested design note for CliffHub');
    failPatch = new Error('notes too long');
    fireEvent.click(within(first).getByRole('button', { name: 'Add to design notes' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('notes too long'));
    failPatch = 'odd';
    fireEvent.click(within(first).getByRole('button', { name: 'Add to design notes' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not save the note'));
    fireEvent.click(within(second).getByRole('button', { name: 'Dismiss suggestion' }));
    expect(screen.getAllByTestId('design-note-suggestion')).toHaveLength(1);
  });

  it('keeps the suggestion inert until the project loads', () => {
    mockApiFetch.mockImplementation(() => new Promise(() => {}));
    renderMarkers('<!-- ex:design-note cliffhub | Rule -->');
    const card = screen.getByTestId('design-note-suggestion');
    expect(within(card).getByText('Suggested design note')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Add to design notes' })).toBeDisabled();
  });

  it('falls back to a standard frame when the mockup has no size', async () => {
    pngWidth = undefined;
    renderMarkers('v1\n<!-- ex:before cliffhub/REF -->');
    fireEvent.click(screen.getByRole('button', { name: 'Compare with the real page' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('img', { name: 'Real page' });
    expect(dialog.querySelector('[data-slot="image-comparison"]')).toHaveStyle({ aspectRatio: '16 / 10' });
  });
});

