import { useMemo, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { highlightToHast, codeFenceLabel } from '@/lib/code-highlight';
import { copyToClipboard } from '@/lib/clipboard';

interface CodeBlockProps {
  code: string;
  language?: string;
}

// CodeBlock renders a fenced code block in a message: syntax-highlighted when
// the fence names a known language (with a line-number gutter), plain
// otherwise, and always with a "copy code" button.
export function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const tree = useMemo(() => highlightToHast(code, language), [code, language]);
  // Validate the fence token against the supported set: a supported language
  // keeps its label, but an unknown one degrades to "plain" rather than leaking
  // an arbitrary token into the label/attribute.
  const langLabel = codeFenceLabel(language);
  // Fences usually carry a trailing newline; drop one so the gutter doesn't
  // show a phantom final line.
  const display = code.replace(/\n$/, '');
  const lineCount = display.split('\n').length;
  const highlighted = tree !== null;
  const rendered: ReactNode = highlighted
    ? toJsxRuntime(tree, { Fragment, jsx, jsxs })
    : display;

  async function handleCopy() {
    await copyToClipboard(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="group relative my-0 overflow-hidden rounded-md bg-muted text-xs font-mono">
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1">
        {langLabel && (
          <span
            data-testid="code-language"
            className="hidden select-none rounded border bg-background/80 px-1.5 py-0.5 text-[10px] font-sans uppercase leading-none tracking-wide text-muted-foreground backdrop-blur md:inline-block"
          >
            {langLabel}
          </span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Code copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
          data-testid="code-copy-button"
          className="inline-flex h-6 w-6 items-center justify-center rounded border bg-background/80 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
        </button>
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
