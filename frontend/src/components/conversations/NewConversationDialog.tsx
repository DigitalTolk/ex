import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useCreateConversation, useSearchUsers } from '@/hooks/useConversations';
import { useAuth } from '@/context/AuthContext';

interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewConversationDialog({
  open,
  onOpenChange,
}: NewConversationDialogProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<
    { id: string; displayName: string }[]
  >([]);
  const [groupName, setGroupName] = useState('');
  const { data: searchResults } = useSearchUsers(searchQuery);
  const createConversation = useCreateConversation();
  const navigate = useNavigate();
  const { user } = useAuth();

  // Self-DM is allowed (a personal notes-to-self channel). Multi-participant
  // groups still strip self in the handler. Search results show everyone
  // including the current user with a "(you)" hint.
  const filteredResults = searchResults ?? [];

  const isGroup = selectedUsers.length > 1;

  function addUser(user: { id: string; displayName: string }) {
    if (selectedUsers.some((u) => u.id === user.id)) return;
    setSelectedUsers((prev) => [...prev, user]);
    setSearchQuery('');
  }

  function removeUser(userId: string) {
    setSelectedUsers((prev) => prev.filter((u) => u.id !== userId));
  }

  function reset() {
    setSearchQuery('');
    setSelectedUsers([]);
    setGroupName('');
  }

  async function handleCreate() {
    if (selectedUsers.length === 0) return;

    createConversation.mutate(
      {
        type: isGroup ? 'group' : 'dm',
        participantIDs: selectedUsers.map((u) => u.id),
        name: isGroup ? groupName.trim() || undefined : undefined,
      },
      {
        onSuccess: (conversation) => {
          reset();
          onOpenChange(false);
          navigate(`/conversation/${conversation.id}`);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
        </DialogHeader>

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

          {/* Selected users */}
          {selectedUsers.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selectedUsers.map((user) => (
                <Badge key={user.id} variant="secondary" className="gap-1">
                  {user.displayName}
                  <button
                    onClick={() => removeUser(user.id)}
                    className="ml-0.5 rounded-full hover:bg-muted"
                    aria-label={`Remove ${user.displayName}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          {/* Search results */}
          {filteredResults.length > 0 && (
            <div className="rounded-md border">
              {filteredResults
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
                ))}
            </div>
          )}

          {/* Group name */}
          {isGroup && (
            <div className="space-y-2">
              <Label htmlFor="group-name">
                Group name{' '}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="group-name"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Name this group conversation"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
