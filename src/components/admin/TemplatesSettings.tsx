import { useState } from 'react';
import { ChevronDown, Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDeleteMessageTemplate, useSaveMessageTemplate } from '@/hooks/useWebhooks';
import { STARTER_TEMPLATE, templateCurl, templatePlaceholders } from '@/lib/message-templates';
import { cn } from '@/lib/utils';
import type { IncomingWebhook, MessageTemplate } from '@/types';

// TemplatesSettings manages a rich webhook's saved layouts. The app posts
// {"template": name, "data": {...}} and ex fills each {{placeholder}}, so a
// layout can change here without the app changing.
export function TemplatesSettings({ webhook }: { webhook: IncomingWebhook }) {
  const [open, setOpen] = useState(false);
  const count = webhook.templates?.length ?? 0;
  return (
    <div className="rounded-md border bg-muted/30" data-testid={`templates-${webhook.id}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium mobile:min-h-11"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', !open && '-rotate-90')} aria-hidden />
        Templates
        <Badge variant="secondary">{count}</Badge>
      </button>
      {open && <TemplatesBody webhook={webhook} />}
    </div>
  );
}

function TemplatesBody({ webhook }: { webhook: IncomingWebhook }) {
  const save = useSaveMessageTemplate();
  const remove = useDeleteMessageTemplate();
  const [key, setKey] = useState('');
  const [text, setText] = useState(STARTER_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const templates = webhook.templates ?? [];
  const keyID = `template-key-${webhook.id}`;
  const textID = `template-json-${webhook.id}`;

  const edit = (t: MessageTemplate) => {
    setKey(t.key);
    setText(JSON.stringify(t.payload, null, 2));
    setError(null);
  };

  const submit = () => {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      setError('The template must be valid JSON.');
      return;
    }
    save.mutate(
      { webhookID: webhook.id, key: key.trim(), payload },
      {
        onSuccess: () => {
          setKey('');
          setText(STARTER_TEMPLATE);
          setError(null);
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Saving failed.'),
      },
    );
  };

  return (
    <div className="space-y-4 border-t px-3 py-4">
      <p className="text-sm text-muted-foreground">
        Save a layout once. Your app then posts <code className="font-mono text-xs">{'{"template": "name", "data": {…}}'}</code> and ex fills each{' '}
        <code className="font-mono text-xs">{'{{placeholder}}'}</code>, so the layout can change here without changing the app.
      </p>
      {templates.length > 0 && (
        <ul className="space-y-2" aria-label="Saved templates">
          {templates.map((t) => {
            const fields = templatePlaceholders(t.payload);
            return (
              <li key={t.key} className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2">
                <code className="font-mono text-sm font-medium">{t.key}</code>
                {fields.map((f) => (
                  <span key={f} className="rounded bg-muted px-1.5 font-mono text-xs text-muted-foreground">
                    {`{{${f}}}`}
                  </span>
                ))}
                <div className="ml-auto flex items-center gap-1">
                  <CopyButton value={templateCurl(webhook.url, t.key, fields)} label={`Copy ${t.key} as cURL`} />
                  <Button variant="ghost" size="icon-sm" aria-label={`Edit ${t.key}`} onClick={() => edit(t)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${t.key}`}
                    onClick={() => setToDelete(t.key)}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="space-y-2">
        <Label htmlFor={keyID}>Name</Label>
        <Input id={keyID} value={key} onChange={(e) => setKey(e.target.value)} placeholder="deploy" className="max-w-xs font-mono" />
      </div>
      <div className="space-y-2">
        <Label htmlFor={textID}>Template</Label>
        <textarea
          id={textID}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          className="min-h-56 w-full resize-y rounded-lg border border-input bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
        />
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button onClick={submit} disabled={save.isPending || !key.trim()}>
        {save.isPending ? 'Saving...' : 'Save template'}
      </Button>
      <ConfirmDialog
        open={toDelete !== null}
        // Controlled: the dialog only ever reports closing.
        onOpenChange={() => setToDelete(null)}
        title="Delete template?"
        description={toDelete ? `Posts naming "${toDelete}" will be refused until it is saved again.` : undefined}
        confirmLabel="Delete template"
        destructive
        // Only open (so only confirmable) while a template is picked.
        onConfirm={() => {
          remove.mutate({ webhookID: webhook.id, key: toDelete as string });
          setToDelete(null);
        }}
      />
    </div>
  );
}
