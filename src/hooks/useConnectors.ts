import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiFetch } from '@/lib/api';

// Connectors: external-service API docs bundles agents can use. Users
// install one by connecting their own account (paste a bearer token, or
// email/password for password-kind connectors). Picked per-message with
// "/slug" in the composer.
export interface Connector {
  slug: string;
  title: string;
  description: string;
  baseURL: string;
  authKind: 'paste' | 'password' | 'sso_window' | 'none';
  // sso_window: the service's SSO entry point the shell opens for one-click
  // connect, and the redirect pattern it captures the minted token from.
  startURL?: string;
  capturePattern?: string;
  // How a pasted credential is sent ("X-Api-Key: {token}" → the form asks
  // for an API key); absent = Authorization: Bearer.
  authHeader?: string;
  installed: boolean;
  installStatus?: 'connected' | 'unverified';
  connectedAs?: string;
  // May agents attach this connector themselves (use_connector)?
  agentUse?: 'ask' | 'always' | 'never';
}

export interface InstallPayload {
  token?: string;
  email?: string;
  password?: string;
  twoFactorCode?: string;
  accessCode?: string;
}

const CONNECTORS_KEY = ['connectors'];

export function useConnectors() {
  return useQuery({
    queryKey: CONNECTORS_KEY,
    queryFn: async () => {
      const res = await apiFetch<{ connectors: Connector[] }>('/api/v1/connectors');
      return res?.connectors ?? [];
    },
  });
}

// TwoFactorError surfaces the auth service's 2FA challenge so the dialog can
// swap to a code input and retry with { twoFactorCode, accessCode }.
export class TwoFactorError extends Error {
  accessCode: string;
  constructor(accessCode: string) {
    super('two-factor code required');
    this.accessCode = accessCode;
  }
}

// SyncResult mirrors POST /api/v1/connectors/sync: what a provider re-pull
// did. Admin-only; the server also polls the provider every minute on its
// own, so the button is for "I just published, show it NOW".
export interface SyncResult {
  synced: string[];
  skipped?: Record<string, string>;
}

export function useSyncConnectors() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<SyncResult>('/api/v1/connectors/sync', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CONNECTORS_KEY }),
  });
}

export function useInstallConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ slug, payload }: { slug: string; payload: InstallPayload }) => {
      try {
        return await apiFetch<{ install: unknown }>(`/api/v1/connectors/${slug}/install`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // The 2FA challenge uses the standard error envelope
          // ({error:{code}}); the bare-string form is the pre-unification
          // shape, kept so a cached SPA build still recognises it.
          const p = err.payload as
            | { error?: string | { code?: string }; accessCode?: string }
            | undefined;
          const code = typeof p?.error === 'string' ? p.error : p?.error?.code;
          if (code === 'two_factor_required') throw new TwoFactorError(p?.accessCode ?? '');
        }
        throw err;
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CONNECTORS_KEY }),
  });
}

export function useUpdateConnectorInstall() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, agentUse }: { slug: string; agentUse: 'ask' | 'always' | 'never' }) =>
      apiFetch(`/api/v1/connectors/${slug}/install`, {
        method: 'PATCH',
        body: JSON.stringify({ agentUse }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CONNECTORS_KEY }),
  });
}

export function useVerifyConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      apiFetch(`/api/v1/connectors/${slug}/verify`, { method: 'POST', body: JSON.stringify({}) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: CONNECTORS_KEY }),
  });
}

export function useUninstallConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      apiFetch(`/api/v1/connectors/${slug}/install`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CONNECTORS_KEY }),
  });
}
