import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TemplatesSettings } from './TemplatesSettings';
import { STARTER_TEMPLATE } from '@/lib/message-templates';
import type { IncomingWebhook } from '@/types';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
const copyMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: copyMock }));

const webhook: IncomingWebhook = {
  id: 'wh-1',
  title: 'Deploys',
  kind: 'rich',
  channelID: 'ch-1',
  lockToChannel: true,
  createdBy: 'u-1',
  createdAt: '',
  updatedAt: '',
  url: 'https://chat.example/hooks/wh-1',
  templates: [{ key: 'deploy', payload: { text: '{{service}} {{version}} is live' }, updatedAt: '' }],
};

function renderSettings(wh: IncomingWebhook = webhook) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TemplatesSettings webhook={wh} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Templates/ }));
}

const calls = (method: string) => mockApiFetch.mock.calls.filter((c) => c[1]?.method === method);

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue(webhook);
  copyMock.mockClear();
});

describe('TemplatesSettings', () => {
  it('folds away, then lists each template with its placeholders and a cURL to post it', async () => {
    renderSettings();
    const toggle = screen.getByRole('button', { name: /Templates/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(toggle).getByText('1')).toBeInTheDocument();
    const row = within(screen.getByRole('list', { name: 'Saved templates' })).getByRole('listitem');
    expect(row).toHaveTextContent('deploy');
    expect(row).toHaveTextContent('{{service}}');
    expect(row).toHaveTextContent('{{version}}');
    fireEvent.click(within(row).getByRole('button', { name: 'Copy deploy as cURL' }));
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith(expect.stringContaining(`"template": "deploy"`)));
    fireEvent.click(toggle);
    expect(screen.queryByRole('list', { name: 'Saved templates' })).toBeNull();
  });

  it('shows no list and a zero count without templates', () => {
    renderSettings({ ...webhook, templates: undefined });
    expect(within(screen.getByRole('button', { name: /Templates/ })).getByText('0')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Saved templates' })).toBeNull();
  });

  it('saves a new template, then clears the form', async () => {
    renderSettings();
    const save = screen.getByRole('button', { name: 'Save template' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' release ' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    const [path, init] = calls('PUT')[0];
    expect(path).toBe('/api/v1/admin/webhooks/wh-1/templates/release');
    expect(JSON.parse(init.body)).toEqual({ payload: JSON.parse(STARTER_TEMPLATE) });
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue(''));
  });

  it('shows the save in flight', async () => {
    mockApiFetch.mockImplementationOnce(() => new Promise(() => {}));
    renderSettings();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'slow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByRole('button', { name: 'Saving...' })).toBeDisabled();
  });

  it('edits a saved template in the form', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Edit deploy' }));
    expect(screen.getByLabelText('Name')).toHaveValue('deploy');
    expect(screen.getByLabelText('Template')).toHaveValue(JSON.stringify(webhook.templates![0].payload, null, 2));
  });

  it('refuses JSON that does not parse, and shows the server refusing a template', async () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'broken' } });
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: '{"text":' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The template must be valid JSON.');
    expect(screen.getByLabelText('Template')).toHaveAttribute('aria-invalid', 'true');
    expect(calls('PUT')).toHaveLength(0);

    mockApiFetch.mockRejectedValueOnce(new Error('webhook: a template is at most 16 KB'));
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: '{"text":"x"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByText('webhook: a template is at most 16 KB')).toBeInTheDocument();

    mockApiFetch.mockRejectedValueOnce('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByText('Saving failed.')).toBeInTheDocument();
  });

  it('deletes a template after confirming, and not when cancelled', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Delete deploy' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Cancel' }))[0]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete template' })).toBeNull());
    expect(calls('DELETE')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete deploy' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete template' }));
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1));
    expect(calls('DELETE')[0][0]).toBe('/api/v1/admin/webhooks/wh-1/templates/deploy');
  });
});
