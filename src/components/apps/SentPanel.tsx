import { CircleCheck } from 'lucide-react';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import type { SentAnswer } from '@/lib/app-view-form';

// SentPanel confirms a finished form: sent to whom, what the app said, and
// what the person entered — so nothing just vanishes.
export function SentPanel({ app, notice, answers }: { app: string; notice?: string; answers: SentAnswer[] }) {
  const { map: people } = useUsersBatch(answers.flatMap((a) => a.userIDs ?? []));
  return (
    <div className="flex flex-col gap-4" data-testid="app-view-sent">
      <div className="flex flex-col items-center gap-2 py-2 text-center" role="status">
        <span className="flex size-12 items-center justify-center rounded-full bg-online/10">
          <CircleCheck className="size-7 text-online" aria-hidden />
        </span>
        <p className="text-base font-semibold">Sent to {app}</p>
        {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      </div>
      {answers.length > 0 && (
        <dl className="flex max-h-72 flex-col gap-2.5 overflow-y-auto rounded-lg border bg-muted/40 p-3 text-sm" aria-label="What you sent">
          {answers.map((a, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{a.label}</dt>
              <dd className="break-words whitespace-pre-wrap">
                {a.userIDs ? a.userIDs.map((id) => people.get(id)?.displayName ?? 'Someone').join(', ') : a.text}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

