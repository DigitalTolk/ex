import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArtifactCard } from '@/components/chat/ArtifactCard';
import type { ArtifactMarker } from '@/lib/artifact-marker';

const mockApiFetch = vi.fn<(path: string) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string) => mockApiFetch(path),
}));

function marker(over: Partial<ArtifactMarker> = {}): ArtifactMarker {
  return { runID: 'r-1', artifactID: 'a-1', title: 'Release notes', kind: 'markdown', bytes: 3584, ...over };
}

function renderCard(m: ArtifactMarker = marker()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ArtifactCard marker={m} />
    </QueryClientProvider>,
  );
}

// jsdom has no createObjectURL and anchor clicks warn about navigation —
// stub the whole save path and capture the anchors it clicks.
let clickedAnchors: HTMLAnchorElement[];
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockApiFetch.mockReset();
  clickedAnchors = [];
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:fake');
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clickedAnchors.push(this);
  });
});

afterEach(() => {
  clickSpy.mockRestore();
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
});

describe('ArtifactCard', () => {
  it('renders title, kind and size without fetching until expanded', () => {
    renderCard();
    expect(screen.getByText('Release notes')).toBeInTheDocument();
    expect(screen.getByText('markdown · 3.5 KB')).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('formats byte sizes as MB and plain bytes', () => {
    renderCard(marker({ bytes: 2 * 1024 * 1024, kind: 'text' }));
    expect(screen.getByText('text · 2.0 MB')).toBeInTheDocument();
    renderCard(marker({ artifactID: 'a-2', bytes: 500, kind: 'json' }));
    expect(screen.getByText('json · 500 B')).toBeInTheDocument();
  });

  it('expands to fetch and show the content, then collapses', async () => {
    let release: (v: unknown) => void = () => {};
    mockApiFetch.mockImplementation(() => new Promise((res) => { release = res; }));
    renderCard();
    const toggle = screen.getByTitle('Expand');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runs/r-1/artifacts/a-1');

    release({ artifact: { title: 'Release notes', kind: 'markdown', content: '## v2 shipped' } });
    expect(await screen.findByText('## v2 shipped')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Collapse'));
    expect(screen.queryByText('## v2 shipped')).not.toBeInTheDocument();
    // Re-expanding shows the cached content immediately (no second fetch).
    fireEvent.click(screen.getByTitle('Expand'));
    expect(screen.getByText('## v2 shipped')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('renders contentless artifacts as an empty block and failures as a notice', async () => {
    mockApiFetch.mockResolvedValue({ artifact: { title: 't', kind: 'text' } });
    renderCard();
    fireEvent.click(screen.getByTitle('Expand'));
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    mockApiFetch.mockRejectedValue(new Error('403'));
    renderCard(marker({ artifactID: 'a-err' }));
    fireEvent.click(screen.getByTitle('Expand'));
    expect(await screen.findByText(/Couldn’t load this artifact/)).toBeInTheDocument();
  });

  it('downloads already-loaded content without a second fetch', async () => {
    mockApiFetch.mockResolvedValue({ artifact: { title: 'x', kind: 'markdown', content: 'body' } });
    renderCard();
    fireEvent.click(screen.getByTitle('Expand'));
    expect(await screen.findByText('body')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Download Release notes'));
    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(clickedAnchors[0].download).toBe('Release notes.md');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('downloads by fetching when not yet loaded, defaulting empty content', async () => {
    mockApiFetch.mockResolvedValue({ artifact: {} });
    renderCard(marker({ title: 'Fix Plan (v2)', kind: 'diff' }));
    fireEvent.click(screen.getByLabelText('Download Fix Plan (v2)'));
    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runs/r-1/artifacts/a-1');
    // Punctuation is stripped from the filename; diff maps to .patch.
    expect(clickedAnchors[0].download).toBe('Fix Plan v2.patch');
  });

  it('maps artifact kinds to download extensions with sensible fallbacks', async () => {
    const cases: Array<[kind: string, ext: string]> = [
      ['md', 'md'],
      ['patch', 'patch'],
      ['json', 'json'],
      ['HTML', 'html'],
      ['weird', 'txt'],
    ];
    for (const [kind, ext] of cases) {
      clickedAnchors = [];
      mockApiFetch.mockResolvedValue({ artifact: { content: 'x' } });
      const view = renderCard(marker({ artifactID: `a-${kind}`, kind }));
      fireEvent.click(screen.getByLabelText('Download Release notes'));
      await waitFor(() => expect(clickedAnchors).toHaveLength(1));
      expect(clickedAnchors[0].download).toBe(`Release notes.${ext}`);
      view.unmount();
    }
    // A title with no filename-safe characters falls back to "artifact".
    clickedAnchors = [];
    mockApiFetch.mockResolvedValue({ artifact: { content: 'x' } });
    renderCard(marker({ artifactID: 'a-sym', title: '???', kind: 'text' }));
    fireEvent.click(screen.getByLabelText('Download ???'));
    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(clickedAnchors[0].download).toBe('artifact.txt');
  });
});
