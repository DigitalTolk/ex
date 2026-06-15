// Syntax highlighting for rendered code blocks. Uses lowlight (highlight.js
// core) with a curated language set to keep the bundle reasonable, and
// returns a hast tree the message renderer hydrates with React. A code
// block only highlights when its fence carries a language we recognise
// (```php, ```ts, …); unknown/absent languages fall back to plain text.
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { Root } from 'hast';

const lowlight = createLowlight({
  bash, c, cpp, csharp, css, go, java, javascript, json, kotlin,
  markdown, php, python, ruby, rust, sql, swift, typescript, xml, yaml,
});

// Common fence aliases → the registered grammar name.
const ALIASES: Record<string, string> = {
  'c++': 'cpp',
  'c#': 'csharp',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  html: 'xml',
  xhtml: 'xml',
  yml: 'yaml',
  golang: 'go',
  md: 'markdown',
  kt: 'kotlin',
};

export function normalizeHighlightLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const lower = language.trim().toLowerCase();
  if (!lower) return undefined;
  return ALIASES[lower] ?? lower;
}

// highlightToHast returns a hast tree of highlighted spans, or null when the
// language is unknown/unsupported (so the caller renders plain text).
export function highlightToHast(code: string, language?: string): Root | null {
  const lang = normalizeHighlightLanguage(language);
  if (!lang || !lowlight.registered(lang)) return null;
  try {
    return lowlight.highlight(lang, code);
  } catch {
    return null;
  }
}
