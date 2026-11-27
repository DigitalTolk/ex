import { useLayoutEffect, useRef, useState } from 'react';
import { visibleCount } from '@/lib/squads-line';

// SquadsLine shows a person's squads on exactly one line: whole handles,
// never broken, as many as fit, then "+N" for the rest. The widths come from
// an invisible copy of every handle, so the count doesn't depend on what is
// currently shown; it is measured again when the line's width changes.
export function SquadsLine({ handles }: { handles: string[] }) {
  const lineRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(handles.length);
  const key = handles.join(',');

  useLayoutEffect(() => {
    const line = lineRef.current!;
    const items = Array.from(measureRef.current!.children) as HTMLElement[];
    const fit = () => {
      const more = items[items.length - 1].offsetWidth;
      setShown(visibleCount(items.slice(0, -1).map((el) => el.offsetWidth), more, line.clientWidth));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(line);
    return () => observer.disconnect();
  }, [key]);

  const hidden = handles.length - Math.min(shown, handles.length);
  return (
    <span ref={lineRef} className="relative flex min-w-0 flex-1 justify-end overflow-hidden whitespace-nowrap">
      <span ref={measureRef} aria-hidden="true" className="invisible absolute right-0 flex whitespace-nowrap">
        {handles.map((handle, i) => (
          <span key={handle}>{i > 0 ? `, @${handle}` : `@${handle}`}</span>
        ))}
        <span className="pl-1">+{handles.length}</span>
      </span>
      <span className="min-w-0 truncate" data-testid="hover-card-usergroups">
        {handles.slice(0, handles.length - hidden).map((handle, i) => (i > 0 ? `, @${handle}` : `@${handle}`)).join('')}
      </span>
      {hidden > 0 && (
        <span className="shrink-0 pl-1 text-muted-foreground" data-testid="hover-card-usergroups-more">
          <span aria-hidden="true">+{hidden}</span>
          <span className="sr-only">and {hidden} more squads</span>
        </span>
      )}
    </span>
  );
}
