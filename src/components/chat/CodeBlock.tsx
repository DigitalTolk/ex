import { useEffect, useSyncExternalStore } from 'react';
import { codeFenceLabel, supportedHighlightLanguage } from '@/lib/code-fence';
import { getHighlighter, highlightedCode, loadHighlighter, subscribeHighlighter } from '@/lib/code-highlight-loader';
import { CopyButton } from '@/components/ui/copy-button';

interface CodeBlockProps {
  code: string;
  language?: string;
}

// CodeBlock renders a fenced code block in a message: syntax-highlighted when
// the fence names a known language (with a line-number gutter), plain
// otherwise, and always with a "copy code" button.
//
// The highlighter loads lazily (lib/code-highlight-loader). A supported block
// renders at its final size from the first paint — gutter, label and the
// same text in the same box — and the colours arrive later without moving
// anything, so the virtualized chat list measures the row once (CLAUDE.md:
// explicit dimensions for chat-list content).
export function CodeBlock({ code, language }: CodeBlockProps) {
  // Validate the fence token against the supported set: a supported language
  // keeps its label, but an unknown one degrades to "plain" rather than leaking
  // an arbitrary token into the label/attribute.
  const langLabel = codeFenceLabel(language);
  const lang = supportedHighlightLanguage(language);
  const highlighter = useSyncExternalStore(subscribeHighlighter, getHighlighter);
  useEffect(() => {
    if (lang) loadHighlighter();
  }, [lang]);
  // Fences usually carry a trailing newline; drop one so the gutter doesn't
  // show a phantom final line.
  const display = code.replace(/\n$/, '');
  const lineCount = display.split('\n').length;
  const highlighted = lang !== undefined;
  // highlightedCode caches per (language, code), so a re-render or a remount
  // reuses the tokens instead of running the grammar again.
  const tokens = lang && highlighter ? highlightedCode(highlighter, display, lang) : null;
  const rendered = tokens ?? display;

  return (
    <div className="group relative my-0 overflow-hidden rounded-md bg-muted text-xs font-mono">
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1">
        {langLabel && (
          <span
            data-testid="code-language"
            className="hidden select-none rounded border bg-background px-1.5 py-0.5 text-xs font-sans uppercase leading-none tracking-wide text-muted-foreground md:inline-block"
          >
            {langLabel}
          </span>
        )}
        <CopyButton
          value={code}
          label="Copy code"
          variant="outline"
          size="icon-xs"
          data-testid="code-copy-button"
          // Hover-revealed on desktop. Touch has no hover: wide touch screens
          // (iPad) show it outright, while the phone chrome stays minimal
          // (whole-message copy lives in the long-press sheet) — but
          // opacity-0 ALONE still hit-tests, leaving an invisible tap target
          // that silently copied on stray taps, so mobile also needs
          // pointer-events-none (same treatment as the sidebar row kebabs).
          // An opaque face, never a backdrop blur: every code block on screen
          // would be its own blurred layer, re-sampled on each frame of a
          // scroll or a slide — what made long chats crash phones.
          className="bg-background text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100 mobile:pointer-events-none mobile:opacity-0"
        />
      </div>
      <div className="flex">
        {highlighted && (
          <pre
            aria-hidden
            data-testid="code-line-numbers"
            className="shrink-0 select-none border-r border-border/60 px-2 py-2 text-right leading-5 text-muted-foreground/70"
          >
            {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
          </pre>
        )}
        <pre
          className="min-w-0 flex-1 overflow-x-auto px-2 py-2 leading-5"
          data-language={langLabel}
        >
          <code className={highlighted ? 'hljs' : undefined}>{rendered}</code>
        </pre>
      </div>
    </div>
  );
}
