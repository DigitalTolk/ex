import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

/** Effective mail configuration, so a test result can be read against it. */
export interface EmailAdminStatus {
  configured: boolean;
  provider: string;
  from: string;
}

export interface TestEmailResult {
  sent: boolean;
  to: string;
  provider: string;
  from: string;
}

// useEmailAdminStatus reads the server's effective mail transport. Not polled:
// this only changes on a redeploy, unlike the search panel's live progress.
export function useEmailAdminStatus() {
  return useQuery({
    queryKey: queryKeys.adminEmailStatus(),
    queryFn: () => apiFetch<EmailAdminStatus>('/api/v1/admin/email'),
    staleTime: 60_000,
  });
}

// useSendTestEmail sends the diagnostic message. An empty recipient tells the
// server to use the calling admin's own address.
//
// Deliberately NOT invalidating the status query: a send neither changes the
// configuration nor should it discard the result the admin is reading.
export function useSendTestEmail() {
  return useMutation({
    mutationFn: (to: string) =>
      apiFetch<TestEmailResult>('/api/v1/admin/email/test', {
        method: 'POST',
        body: JSON.stringify({ to }),
      }),
  });
}
