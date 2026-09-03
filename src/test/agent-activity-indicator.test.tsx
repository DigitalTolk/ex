import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { AgentActivityIndicator } from '@/components/chat/AgentActivityIndicator';
import { onRunProgress, onRunUpdated, resetAgentRunsSessionState } from '@/stores/agent-runs';
import { closeRunDrawer, useRunDrawerStore } from '@/stores/run-drawer';
import type { UserMapEntry } from '@/components/chat/MessageList';

const userMap: Record<string, UserMapEntry> = {
  'ag-1': { displayName: 'gg' },
  'ag-2': { displayName: 'dev' },
  'u-1': { displayName: 'Ada' },
};

function seedRun(id: string, over: Record<string, unknown> = {}) {
  act(() =>
    onRunUpdated({ id, agentID: 'ag-1', invokerID: 'u-1', parentID: 'c-1', state: 'running', ...over }),
  );
}

afterEach(() => {
  act(() => {
    resetAgentRunsSessionState();
    closeRunDrawer();
  });
});

describe('AgentActivityIndicator', () => {
  it('renders nothing without a parentID even when runs exist elsewhere', () => {
    seedRun('r-1');
    render(<AgentActivityIndicator userMap={userMap} />);
    expect(screen.queryByTestId('agent-activity-indicator')).not.toBeInTheDocument();
  });

  it('renders nothing when the parent has no live runs', () => {
    seedRun('r-1', { parentID: 'c-other' });
    render(<AgentActivityIndicator parentID="c-1" userMap={userMap} />);
    expect(screen.queryByTestId('agent-activity-indicator')).not.toBeInTheDocument();
  });

  it('shows a single run as agent + invoker + live action and opens its drawer on click', () => {
    seedRun('r-1');
    act(() =>
      onRunProgress({ runID: 'r-1', agentID: 'ag-1', parentID: 'c-1', kind: 'tool', tool: 'post_message' }),
    );
    render(<AgentActivityIndicator parentID="c-1" userMap={userMap} />);
    const chip = screen.getByTestId('agent-activity-chip');
    expect(chip).toHaveTextContent('gg');
    expect(chip).toHaveTextContent('for Ada');
    expect(chip).toHaveTextContent('posting a reply…');
    expect(chip).not.toHaveAttribute('aria-expanded');
    expect(chip).toHaveAttribute('title', 'Open run activity');

    fireEvent.click(chip);
    expect(useRunDrawerStore.getState().runID).toBe('r-1');
    expect(screen.queryByTestId('agent-activity-list')).not.toBeInTheDocument();
  });

  it('falls back to "agent" and hides the invoker when the user map has no names', () => {
    seedRun('r-1', { invokerID: undefined });
    render(<AgentActivityIndicator parentID="c-1" />);
    const chip = screen.getByTestId('agent-activity-chip');
    expect(chip).toHaveTextContent('agent');
    expect(chip).not.toHaveTextContent('for');
  });

  it('collapses several runs into a count that expands to a picker', () => {
    seedRun('r-1');
    seedRun('r-2', { agentID: 'ag-2', invokerID: undefined });
    render(<AgentActivityIndicator parentID="c-1" userMap={userMap} />);
    const chip = screen.getByTestId('agent-activity-chip');
    expect(chip).toHaveTextContent('2 agents working');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip).not.toHaveAttribute('title');

    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByTestId('agent-activity-list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('gg');
    expect(rows[0]).toHaveTextContent('for Ada');
    expect(rows[1]).toHaveTextContent('dev');
    expect(rows[1]).not.toHaveTextContent('for');

    // Picking a run closes the popover and opens that run's drawer.
    fireEvent.click(rows[1]);
    expect(useRunDrawerStore.getState().runID).toBe('r-2');
    expect(screen.queryByTestId('agent-activity-list')).not.toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles the popover closed from the chip and closes on Escape or outside press', () => {
    seedRun('r-1');
    seedRun('r-2', { agentID: 'ag-2' });
    render(<AgentActivityIndicator parentID="c-1" userMap={userMap} />);
    const chip = screen.getByTestId('agent-activity-chip');

    // Chip toggle: open then closed again.
    fireEvent.click(chip);
    expect(screen.getByTestId('agent-activity-list')).toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.queryByTestId('agent-activity-list')).not.toBeInTheDocument();

    // Escape closes; other keys do not.
    fireEvent.click(chip);
    fireEvent.keyDown(document, { key: 'a' });
    expect(screen.getByTestId('agent-activity-list')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('agent-activity-list')).not.toBeInTheDocument();

    // A pointerdown inside the indicator keeps it open; outside closes it.
    fireEvent.click(chip);
    fireEvent(chip, new Event('pointerdown', { bubbles: true }));
    expect(screen.getByTestId('agent-activity-list')).toBeInTheDocument();
    fireEvent(document.body, new Event('pointerdown', { bubbles: true }));
    expect(screen.queryByTestId('agent-activity-list')).not.toBeInTheDocument();
  });

  it('drops the chip as soon as the last run reaches a terminal state', () => {
    seedRun('r-1');
    render(<AgentActivityIndicator parentID="c-1" userMap={userMap} />);
    expect(screen.getByTestId('agent-activity-chip')).toBeInTheDocument();
    seedRun('r-1', { state: 'completed' });
    expect(screen.queryByTestId('agent-activity-chip')).not.toBeInTheDocument();
  });
});
