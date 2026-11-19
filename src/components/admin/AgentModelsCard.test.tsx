import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AgentModelsCard } from './AgentModelsCard';
import { AgentModelSelect } from '@/pages/agents/AgentModelSelect';
import { harnessHasModelList } from '@/hooks/useAgentModels';
import type { AgentModelOption } from '@/types';

type ApiInit = { method?: string; body?: string };
const mockApiFetch = vi.hoisted(() => vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>());
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

const saved: AgentModelOption[] = [
  { harness: 'claude', id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { harness: 'claude', id: 'claude-sonnet-5-5' },
  { harness: 'bedrock', id: 'eu.anthropic.claude-opus-5', label: 'Claude Opus 5 (EU)' },
];

let settingsModels: AgentModelOption[] | undefined;
let putResult: (body: { models: AgentModelOption[] }) => Promise<unknown>;

function installApi() {
  mockApiFetch.mockImplementation((path, init) => {
    if (path === '/api/v1/admin/settings') {
      return Promise.resolve({ maxUploadBytes: 0, allowedExtensions: [], agentModels: settingsModels });
    }
    if (path === '/api/v1/admin/agent-models' && init?.method === 'PUT') {
      return putResult(JSON.parse(init.body!));
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const optionsOf = (el: HTMLElement) => Array.from((el as HTMLSelectElement).options).map((o) => o.textContent);
const engine = (harness: string) => within(screen.getByTestId(`agent-models-${harness}`));

beforeEach(() => {
  mockApiFetch.mockReset();
  settingsModels = saved;
  putResult = async (body) => ({ maxUploadBytes: 0, allowedExtensions: [], agentModels: body.models });
  installApi();
});

describe('AgentModelsCard', () => {
  it('lists the models offered for each engine, by name and id', async () => {
    wrap(<AgentModelsCard />);
    expect(await screen.findByText('Claude Opus 5.5')).toBeInTheDocument();
    expect(engine('claude').getAllByRole('listitem')).toHaveLength(2);
    // A model with no name shows its id.
    expect(engine('claude').getAllByText('claude-sonnet-5-5')).toHaveLength(2);
    expect(engine('bedrock').getByText('Claude Opus 5 (EU)')).toBeInTheDocument();
    // Nothing changed: no Save.
    expect(screen.queryByTestId('agent-models-save')).toBeNull();
    // The last model of an engine cannot go: its dropdown would be empty.
    expect(engine('bedrock').getByRole('button', { name: 'Remove Claude Opus 5 (EU)' })).toBeDisabled();
    expect(engine('claude').getByRole('button', { name: 'Remove Claude Opus 5.5' })).toBeEnabled();
  });

  it('adds and removes models, then saves the whole list', async () => {
    let sent: AgentModelOption[] | undefined;
    putResult = async (body) => {
      sent = body.models;
      return { maxUploadBytes: 0, allowedExtensions: [], agentModels: body.models };
    };
    wrap(<AgentModelsCard />);
    await screen.findByText('Claude Opus 5.5');

    // Bedrock takes EU Claude profiles only.
    const bedrockID = engine('bedrock').getByLabelText('Model id');
    const addBedrock = screen.getByTestId('agent-models-add-bedrock');
    fireEvent.change(bedrockID, { target: { value: 'us.anthropic.claude-opus-5' } });
    expect(addBedrock).toBeDisabled();
    expect(bedrockID).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(bedrockID, { target: { value: ' eu.anthropic.claude-sonnet-5 ' } });
    fireEvent.change(engine('bedrock').getByLabelText('Name (optional)'), { target: { value: ' Claude Sonnet 5 (EU) ' } });
    expect(addBedrock).toBeEnabled();
    fireEvent.click(addBedrock);
    expect(engine('bedrock').getByText('Claude Sonnet 5 (EU)')).toBeInTheDocument();
    expect(bedrockID).toHaveValue('');

    // Claude Code: a model with no name, and one already listed.
    const claudeID = engine('claude').getByLabelText('Model id');
    fireEvent.change(claudeID, { target: { value: 'claude-opus-5-5' } });
    expect(screen.getByTestId('agent-models-add-claude')).toBeDisabled();
    expect(engine('claude').getByText('claude-opus-5-5 is already listed.')).toBeInTheDocument();
    fireEvent.change(claudeID, { target: { value: 'claude-haiku-5-5' } });
    fireEvent.click(screen.getByTestId('agent-models-add-claude'));
    fireEvent.click(engine('claude').getByRole('button', { name: 'Remove Claude Opus 5.5' }));

    fireEvent.click(screen.getByTestId('agent-models-save'));
    await waitFor(() => expect(screen.queryByTestId('agent-models-save')).toBeNull());
    expect(sent).toEqual([
      { harness: 'claude', id: 'claude-sonnet-5-5' },
      { harness: 'bedrock', id: 'eu.anthropic.claude-opus-5', label: 'Claude Opus 5 (EU)' },
      { harness: 'bedrock', id: 'eu.anthropic.claude-sonnet-5', label: 'Claude Sonnet 5 (EU)' },
      { harness: 'claude', id: 'claude-haiku-5-5' },
    ]);
    // The saved list is what shows now.
    expect(engine('claude').queryByText('Claude Opus 5.5')).toBeNull();
  });

  it('says what went wrong when the save is refused, and Cancel puts the saved list back', async () => {
    let finish!: (v: unknown) => void;
    putResult = () => new Promise((_, reject) => (finish = reject));
    wrap(<AgentModelsCard />);
    await screen.findByText('Claude Opus 5.5');
    fireEvent.click(engine('claude').getByRole('button', { name: 'Remove Claude Opus 5.5' }));

    fireEvent.click(screen.getByTestId('agent-models-save'));
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
    finish(new Error('list at least one model for bedrock'));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save: list at least one model for bedrock");

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('agent-models-save')).toBeNull();
    expect(engine('claude').getByText('Claude Opus 5.5')).toBeInTheDocument();
  });

  it('shows a placeholder while the settings load', () => {
    mockApiFetch.mockImplementation(() => new Promise(() => {}));
    wrap(<AgentModelsCard />);
    expect(screen.queryByTestId('agent-models-claude')).toBeNull();
    expect(screen.getByTestId('agent-models-card').querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });
});

function Picker({ harness, initial = '' }: { harness: string; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="m">Model</label>
      <AgentModelSelect id="m" harness={harness} value={value} onChange={setValue} emptyLabel="Default" placeholder="codex default" />
      <output data-testid="picked">{value}</output>
    </>
  );
}

describe('AgentModelSelect', () => {
  it("offers the engine's models after its default, and picks one", async () => {
    wrap(<Picker harness="claude" />);
    await waitFor(() => expect(optionsOf(screen.getByLabelText('Model'))).toEqual(['Default', 'Claude Opus 5.5', 'claude-sonnet-5-5']));
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-sonnet-5-5' } });
    expect(screen.getByTestId('picked')).toHaveTextContent('claude-sonnet-5-5');
  });

  it('keeps a saved model that is no longer offered, marked', async () => {
    wrap(<Picker harness="bedrock" initial="eu.anthropic.claude-old" />);
    await waitFor(() =>
      expect(optionsOf(screen.getByLabelText('Model'))).toEqual([
        'Default',
        'Claude Opus 5 (EU)',
        'eu.anthropic.claude-old (no longer offered)',
      ]),
    );
    expect(screen.getByLabelText('Model')).toHaveValue('eu.anthropic.claude-old');
  });

  it('is free text for Codex, which has no list', () => {
    wrap(<Picker harness="codex" initial="gpt-x" />);
    const field = screen.getByLabelText('Model');
    expect(field.tagName).toBe('INPUT');
    expect(field).toHaveAttribute('placeholder', 'codex default');
    fireEvent.change(field, { target: { value: 'gpt-y' } });
    expect(screen.getByTestId('picked')).toHaveTextContent('gpt-y');
  });

  it('offers only the default before any list arrives', () => {
    settingsModels = undefined;
    mockApiFetch.mockImplementation(() => new Promise(() => {}));
    wrap(<Picker harness="claude" />);
    expect(optionsOf(screen.getByLabelText('Model'))).toEqual(['Default']);
  });

  it('knows which engines pick from a list', () => {
    expect(['claude', 'bedrock', 'codex', ''].map(harnessHasModelList)).toEqual([true, true, false, false]);
  });
});
