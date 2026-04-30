import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useQueryClient } from '@tanstack/react-query';

interface AddMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
}

export function AddMemberDialog({ open, onOpenChange, channelId }: AddMemberDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; displayName: string; email: string }[]>([]);
  const [selectedUser, setSelectedUser] = useState<{ id: string; displayName: string } | null>(null);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (query.length < 2) {
      const clear = async () => setResults([]);
      clear();
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const users = await apiFetch<{ id: string; displayName: string; email: string }[]>(
          `/api/v1/users?q=${encodeURIComponent(query)}`,
        );
        setResults(users);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUser) {
      setError('Please select a user from the search results');
      return;
    }
    setError('');
    setIsSubmitting(true);
    try {
      await apiFetch(`/api/v1/channels/${channelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userID: selectedUser.id, role: 'member' }),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers(channelId) });
      setQuery('');
      setSelectedUser(null);
      setResults([]);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg min-h-[400px]">
        <DialogHeader><DialogTitle>Add member</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          <Input
            value={selectedUser ? selectedUser.displayName : query}
            onChange={e => { setQuery(e.target.value); setSelectedUser(null); }}
            placeholder="Search by name or email..."
            required
            autoFocus
          />
          {results.length > 0 && !selectedUser && (
            <div className="border rounded-md max-h-40 overflow-y-auto">
              {results.map(u => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => { setSelectedUser({ id: u.id, displayName: u.displayName }); setQuery(''); setResults([]); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 flex justify-between"
                >
                  <span>{u.displayName}</span>
                  <span className="text-muted-foreground">{u.email}</span>
                </button>
              ))}
            </div>
          )}
          <Button type="submit" className="w-full" disabled={isSubmitting || !selectedUser}>
            {isSubmitting ? 'Adding...' : 'Add member'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
