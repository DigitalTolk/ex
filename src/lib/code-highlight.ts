// Syntax highlighting for rendered code blocks. Uses lowlight (highlight.js
// core) with a curated language set to keep the bundle reasonable, and
// returns a hast tree the message renderer hydrates with React. A code
// block only highlights when its fence carries a language we recognise
// (```php, ```ts, …); unknown/absent languages fall back to plain text.
//
// Loaded lazily (lib/code-highlight-loader), so the grammars stay out of the
// boot bundle. What a fence token means is answered synchronously by
// lib/code-fence: the gutter and label are needed at a block's first render.
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
import { normalizeHighlightLanguage } from '@/lib/code-fence';

export { codeFenceLabel, normalizeHighlightLanguage, supportedHighlightLanguage } from '@/lib/code-fence';

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

// Exported for the test that keeps lib/code-fence's list of names in step.
export const grammars: Record<string, LanguageFn> = {
  bash, c, cpp, csharp, css, go, hcl, ini, java, javascript, json, kotlin,
  markdown, php, python, ruby, rust, sql, swift, typescript, xml, yaml,
};

const lowlight = createLowlight(grammars);

export function isRegisteredHighlightLanguage(name: string): boolean {
  return lowlight.registered(name);
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
