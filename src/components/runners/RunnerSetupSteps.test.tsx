import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { EX_RUNNER_README, EX_RUNNER_RELEASES, RunnerSetupSteps } from './RunnerSetupSteps';

// The command-line way to connect a computer. The account menu's Runners
// dialog shows the short form (covered with the dialog); the full, numbered
// form is off the Runners page for now and is kept working here.
describe('RunnerSetupSteps', () => {
  it('lists the three Homebrew steps in order, each with its command to copy, for this server', () => {
    render(<RunnerSetupSteps />);
    const steps = within(screen.getByTestId('runner-setup-steps')).getAllByRole('listitem');
    const login = `ex-runner login ${window.location.origin}`;
    expect(steps.map((li) => li.querySelector('code')?.textContent)).toEqual([
      'brew install digitaltolk/tools/ex-runner',
      login,
      'brew services start ex-runner',
    ]);
    expect(steps[0]).toHaveTextContent('Install ex-runner');
    expect(steps[1]).toHaveTextContent('Connect it to your account');
    expect(steps[2]).toHaveTextContent('Start it in the background');
    expect(within(steps[1]).getByRole('button', { name: `Copy "${login}"` })).toBeInTheDocument();
  });

  it('points to the download for a computer without Homebrew', () => {
    render(<RunnerSetupSteps />);
    expect(screen.getByRole('link', { name: 'Download ex-runner' })).toHaveAttribute('href', EX_RUNNER_RELEASES);
    expect(screen.getByTestId('runner-setup-steps')).toHaveTextContent('then run the login command above and ex-runner start');
  });

  it('in its short form, links to the install guide and gives the two commands', () => {
    render(<RunnerSetupSteps compact />);
    expect(screen.queryByTestId('runner-setup-steps')).toBeNull();
    expect(screen.getByRole('link', { name: 'install ex-runner' })).toHaveAttribute('href', EX_RUNNER_README);
    expect(screen.getByText(`ex-runner login ${window.location.origin}`)).toBeInTheDocument();
    expect(screen.getByText('ex-runner start')).toBeInTheDocument();
  });
});
