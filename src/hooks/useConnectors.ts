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
  authKind: 'paste' | 'password' | 'none';
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
  constructor(public accessCode: string) {
    super('two-factor code required');
  }
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
          const p = err.payload as { error?: string; accessCode?: string } | undefined;
          if (p?.error === 'two_factor_required') throw new TwoFactorError(p.accessCode ?? '');
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
