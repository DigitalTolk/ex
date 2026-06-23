// Syntax highlighting for rendered code blocks. Uses lowlight (highlight.js
// core) with a curated language set to keep the bundle reasonable, and
// returns a hast tree the message renderer hydrates with React. A code
// block only highlights when its fence carries a language we recognise
// (```php, ```ts, …); unknown/absent languages fall back to plain text.
import { createLowlight } from 'lowlight';
import type { HLJSApi, Language, LanguageFn } from 'highlight.js';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
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

// highlight.js ships no HCL/Terraform grammar, so register a compact one: block
// types + literals as keywords, #, // and /* */ comments, strings, numbers,
// ${…} interpolation, and attribute names before "=".
const hcl: LanguageFn = (hljs: HLJSApi): Language => ({
  name: 'HCL',
  aliases: ['terraform', 'tf'],
  keywords: {
    keyword: 'resource variable output module data provider terraform locals dynamic for_each',
    literal: 'true false null',
  },
  contains: [
    hljs.HASH_COMMENT_MODE,
    hljs.C_LINE_COMMENT_MODE,
    hljs.C_BLOCK_COMMENT_MODE,
    hljs.QUOTE_STRING_MODE,
    hljs.NUMBER_MODE,
    { className: 'variable', begin: /\$\{/, end: /\}/ },
    { className: 'attr', begin: /[A-Za-z_]\w*(?=\s*=[^=])/ },
  ],
});

const lowlight = createLowlight({
  bash, c, cpp, csharp, css, go, hcl, ini, java, javascript, json, kotlin,
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
  htm: 'xml',
  yml: 'yaml',
  golang: 'go',
  md: 'markdown',
  kt: 'kotlin',
  terraform: 'hcl',
  tf: 'hcl',
  toml: 'ini',
};

export function normalizeHighlightLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const lower = language.trim().toLowerCase();
  if (!lower) return undefined;
  return ALIASES[lower] ?? lower;
}

// supportedHighlightLanguage validates a fence language against the registered
// grammar set and returns its canonical name, or undefined when the language is
// absent or unknown. Callers MUST NOT trust the raw fence token (it's arbitrary
// user input that would otherwise leak into a class/label) — an unknown language
// falls back to a plain block.
export function supportedHighlightLanguage(language?: string): string | undefined {
  const lang = normalizeHighlightLanguage(language);
  if (!lang || !lowlight.registered(lang)) return undefined;
  return lang;
}

// codeFenceLabel is what to show/attribute for a fence: the author's token when
// it names a supported language, "plain" when it's present-but-unsupported, or
// undefined when no language was given. Shared by both code-block renderers so
// messages and previews label identically.
export function codeFenceLabel(language?: string): string | undefined {
  if (!language) return undefined;
  return supportedHighlightLanguage(language) ? language : 'plain';
}

// highlightToHast returns a hast tree of highlighted spans, or null when the
// language is unknown/unsupported (so the caller renders plain text).
export function highlightToHast(code: string, language?: string): Root | null {
  const lang = supportedHighlightLanguage(language);
  if (!lang) return null;
  try {
    return lowlight.highlight(lang, code);
  } catch {
    return null;
  }
}
