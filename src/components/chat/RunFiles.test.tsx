import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { RunFiles } from './RunFiles';
import type { RunFile } from '@/lib/run-timeline';

function file(over: Partial<RunFile>): RunFile {
  return { id: 'f', role: 'posted', runID: 'r1', filename: 'f.png', contentType: 'image/png', size: 1024, url: '/m/f', ...over };
}

describe('RunFiles', () => {
  it('renders nothing when the run touched no files', () => {
    const { container } = render(<RunFiles files={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('groups files by what the run did with them', () => {
    render(
      <RunFiles
        files={[
          file({ id: 'g', role: 'given', filename: 'request.png', thumbnailURL: '/t/g' }),
          file({ id: 's', role: 'fetched', source: 'project_screen', filename: 'home.png' }),
          file({ id: 'h', role: 'fetched', source: 'message', filename: 'v1.html', contentType: 'text/html', size: 2048, url: '/api/v1/media/tok-h/v1.html', downloadURL: '/d/h' }),
          file({ id: 'p', role: 'posted', filename: 'v2.png', url: undefined }),
          file({ id: 'c', role: 'posted', filename: 'data.csv', contentType: 'text/csv', url: undefined }),
        ]}
      />,
    );
    const given = screen.getByRole('region', { name: 'Given to it' });
    expect(within(given).getByRole('heading')).toHaveTextContent('Given to it (1)');
    expect(given.querySelector('img')).toHaveAttribute('src', '/t/g');

    const fetched = screen.getByRole('region', { name: 'Looked at' });
    expect(within(fetched).getByRole('heading')).toHaveTextContent('Looked at (2)');
    expect(within(fetched).getByRole('button', { name: 'View home.png' })).toHaveAttribute('title', 'home.png — Project reference screen');
    expect(within(fetched).getByText('v1.html')).toBeInTheDocument();
    expect(within(fetched).getByRole('button', { name: 'Preview v1.html' })).toBeInTheDocument();
    expect(within(fetched).getByRole('link', { name: 'Download v1.html' })).toHaveAttribute('href', '/d/h');

    const posted = screen.getByRole('region', { name: 'Posted' });
    // No URL: the tile falls back to its name, and no download link appears.
    expect(within(posted).getByRole('button', { name: 'View v2.png' })).toHaveTextContent('v2.png');
    expect(within(posted).getByText('data.csv')).toBeInTheDocument();
    expect(within(posted).queryByRole('link')).not.toBeInTheDocument();
  });

  it('opens an image full size with where it came from', async () => {
    render(
      <RunFiles
        files={[
          file({ id: 'g', role: 'given', filename: 'request.png', width: 800, height: 600 }),
          file({ id: 't', role: 'fetched', source: 'message', filename: 'thread.png' }),
          file({ id: 'p', role: 'posted', filename: 'out.png', url: undefined }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View request.png' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Attached to the request')).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: 'request.png' })).toHaveAttribute('width', '800');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'View thread.png' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('From the thread')).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: 'thread.png' })).not.toHaveAttribute('width');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'View out.png' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Posted by the agent')).toBeInTheDocument();
    expect(within(dialog).queryByRole('img')).not.toBeInTheDocument();
  });
});
