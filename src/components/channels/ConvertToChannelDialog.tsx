import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useConvertConversation } from '@/hooks/useConvertConversation';
import { useChannelName } from '@/hooks/useChannelName';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useAutoFocusTextInput } from '@/hooks/useHardwareKeyboard';
import { ApiError } from '@/lib/api';
import { ChannelNameField } from './ChannelNameField';

interface ConvertToChannelDialogProps {
  conversationID: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ConvertToChannelDialog names the private channel a group message becomes.
export function ConvertToChannelDialog({ conversationID, open, onOpenChange }: ConvertToChannelDialogProps) {
  const nameField = useChannelName();
  const { finalName, nameError } = nameField;
  const [submitError, setSubmitError] = useState('');
  const convert = useConvertConversation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const autoFocusTextInput = useAutoFocusTextInput();
  const canSubmit = !!finalName && !nameError && !convert.isPending;

  function submit() {
    setSubmitError('');
    if (!finalName || nameError) return;
    const submitted = finalName;
    nameField.setName(submitted);
    convert.mutate(
      { conversationID, name: submitted },
      {
        onSuccess: (channel) => {
          onOpenChange(false);
          // The conversation is no more: its page gives way to the channel's.
          navigate(`/channel/${channel.slug}`, { replace: true });
        },
        onError: (err: unknown) => {
          if (err instanceof ApiError && err.status === 409 && /name/.test(err.message)) {
            nameField.taken(submitted);
            return;
          }
          setSubmitError(err instanceof Error ? err.message : 'Failed to convert');
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        mobileCloseLabel="Cancel"
        mobileAction={
          isMobile
            ? { label: convert.isPending ? 'Converting...' : 'Convert', onClick: submit, disabled: !canSubmit }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>Convert to private channel</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-4"
        >
          <ChannelNameField field={nameField} autoFocus={autoFocusTextInput} />
          <p
            data-testid="convert-submit-error"
            role={submitError ? 'alert' : undefined}
            className={`min-h-[1.25rem] text-sm ${submitError ? 'text-destructive' : ''}`}
          >
            {submitError}
          </p>
          {!isMobile && (
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {convert.isPending ? 'Converting...' : 'Convert'}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
