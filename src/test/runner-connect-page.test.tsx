import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RunnerConnectPage from '@/pages/RunnerConnectPage';
import { takeReturnTo } from '@/lib/return-to';
import { runnerConnectNav } from '@/lib/runner-connect';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

let mockAuth: { user: { displayName: string } | null; isAuthenticated: boolean; isLoading: boolean };
vi.mock('@/context/AuthContext', () => ({ useAuth: () => mockAuth }));

const STATE = 'AbCdEfGhIjKlMnOpQrStUv';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const LINK = `/runner/connect?port=43123&state=${STATE}&challenge=${CHALLENGE}&name=Alices-Mac`;

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/runner/connect" element={<RunnerConnectPage />} />
          <Route path="/login" element={<div data-testid="login-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RunnerConnectPage', () => {
  let leaveFor: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockAuth = { user: { displayName: 'Alice' }, isAuthenticated: true, isLoading: false };
    leaveFor = vi.spyOn(runnerConnectNav, 'leaveFor').mockImplementation(() => {});
    sessionStorage.clear();
  });

  it('explains a broken link', () => {
    renderAt('/runner/connect?port=80');
    expect(screen.getByText("This link isn't valid")).toBeInTheDocument();
  });

  it('waits while the session restores', () => {
    mockAuth = { user: null, isAuthenticated: false, isLoading: true };
    renderAt(LINK);
    expect(screen.getByRole('status')).toHaveTextContent('Checking your sign-in');
  });

  it('sends a signed-out visitor to login and remembers to come back', () => {
    mockAuth = { user: null, isAuthenticated: false, isLoading: false };
    renderAt(LINK);
    expect(screen.getByText(/Alices-Mac/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
    expect(takeReturnTo('/fallback')).toBe(LINK);
  });

  it('asks before connecting, naming the machine and the account', () => {
    renderAt(LINK);
    expect(screen.getByText('Connect ex-runner?')).toBeInTheDocument();
    expect(screen.getByText('Alices-Mac')).toBeInTheDocument();
    expect(screen.getByText(/with your access as Alice/)).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('connects: mints a grant for the challenge and returns the code to the local listener', async () => {
    mockApiFetch.mockResolvedValue({ code: 'one-time', expiresAt: 'soon' });
    renderAt(LINK);
    fireEvent.click(screen.getByTestId('runner-connect-approve'));
    expect(await screen.findByText('ex-runner is connected')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/grants', {
      method: 'POST',
      body: JSON.stringify({ challenge: CHALLENGE, label: 'Alices-Mac' }),
    });
    expect(leaveFor).toHaveBeenCalledWith(`http://127.0.0.1:43123/callback?code=one-time&state=${STATE}`);
  });

  it('shows the server’s refusal and stays put', async () => {
    let fail!: (e: Error) => void;
    mockApiFetch.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    renderAt(LINK);
    fireEvent.click(screen.getByTestId('runner-connect-approve'));
    await waitFor(() => expect(screen.getByTestId('runner-connect-approve')).toHaveTextContent('Connecting…'));
    fail(new Error("this account can't connect a runner"));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't connect: this account can't connect a runner");
    expect(leaveFor).not.toHaveBeenCalled();
  });

  it('cancels: tells the listener nothing was approved', () => {
    renderAt(LINK);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(leaveFor).toHaveBeenCalledWith(`http://127.0.0.1:43123/callback?error=access_denied&state=${STATE}`);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
