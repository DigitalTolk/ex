import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useCreateConversation, useSearchUsers } from '@/hooks/useConversations';
import { useAuth } from '@/context/AuthContext';

export default function NewConversationPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<
    { id: string; displayName: string }[]
  >([]);
  const { data: searchResults } = useSearchUsers(searchQuery);
  const createConversation = useCreateConversation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const filteredResults = searchResults ?? [];
  const isGroup = selectedUsers.length > 1;

  function addUser(u: { id: string; displayName: string }) {
    if (selectedUsers.some((s) => s.id === u.id)) return;
    setSelectedUsers((prev) => [...prev, u]);
    setSearchQuery('');
  }

  function removeUser(userId: string) {
    setSelectedUsers((prev) => prev.filter((s) => s.id !== userId));
  }

  function handleCreate() {
    if (selectedUsers.length === 0) return;
    createConversation.mutate(
      {
        type: isGroup ? 'group' : 'dm',
        participantIDs: selectedUsers.map((u) => u.id),
      },
      {
        onSuccess: (conversation) => {
          navigate(`/conversation/${conversation.id}`, { replace: true });
        },
      },
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl p-6">
        <div className="mb-4 flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => navigate(-1)}
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl font-bold">New conversation</h1>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="user-search">Search users</Label>
            <Input
              id="user-search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Type a name or email..."
              autoFocus
            />
          </div>

          {selectedUsers.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selectedUsers.map((u) => (
                <Badge
                  key={u.id}
                  variant="secondary"
                  data-testid="participant-pill"
                  className="gap-1 text-sm h-auto py-1 px-2"
                >
                  {u.displayName}
                  <button
                    onClick={() => removeUser(u.id)}
                    className="ml-0.5 rounded-full hover:bg-muted"
                    aria-label={`Remove ${u.displayName}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          <div
            data-testid="results-region"
            className="h-72 overflow-y-auto rounded-md border"
          >
            {filteredResults.length === 0 ? (
              <p className="flex h-full items-center justify-center px-3 text-sm text-muted-foreground">
                {searchQuery.trim().length < 2
                  ? 'Start typing to search for users'
                  : 'No users found'}
              </p>
            ) : (
              filteredResults
                .filter((u) => !selectedUsers.some((s) => s.id === u.id))
                .map((u) => (
                  <button
                    key={u.id}
                    onClick={() =>
                      addUser({ id: u.id, displayName: u.displayName })
                    }
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50 first:rounded-t-md last:rounded-b-md"
                  >
                    <span className="font-medium">{u.displayName}</span>
                    {u.id === user?.id && (
                      <span className="text-xs text-muted-foreground">(you)</span>
                    )}
                    <span className="text-muted-foreground">{u.email}</span>
                  </button>
                ))
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={selectedUsers.length === 0 || createConversation.isPending}
            >
              {createConversation.isPending
                ? 'Creating...'
                : isGroup
                  ? 'Create Group'
                  : 'Start Conversation'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
