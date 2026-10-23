// What a code fence's language token means, answered without the highlighter.
// The grammars (lib/code-highlight) load lazily, but a code block must know at
// its first render whether it will be highlighted — the line-number gutter
// and the language label are part of its height, and a chat row has to paint
// at its final size (react-virtuoso measures it then).

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

// Every name lib/code-highlight registers with lowlight: each grammar's name
// and the aliases highlight.js gives it. code-fence.test.ts checks this list
// against the real registration, so the two cannot drift.
export const REGISTERED_HIGHLIGHT_LANGUAGES: ReadonlySet<string> = new Set([
  'bash', 'sh', 'zsh',
  'c', 'h',
  'cpp', 'cc', 'c++', 'h++', 'hpp', 'hh', 'hxx', 'cxx',
  'csharp', 'cs', 'c#',
  'css',
  'go', 'golang',
  'hcl', 'terraform', 'tf',
  'ini', 'toml',
  'java', 'jsp',
  'javascript', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonc', 'json5',
  'kotlin', 'kt', 'kts', 'ktm', 'ktx',
  'markdown', 'md', 'mkdown', 'mkd',
  'php',
  'python', 'py', 'gyp', 'ipython',
  'ruby', 'rb', 'gemspec', 'podspec', 'thor', 'irb',
  'rust', 'rs',
  'sql',
  'swift',
  'typescript', 'ts', 'tsx', 'mts', 'cts',
  'xml', 'html', 'xhtml', 'rss', 'atom', 'xjb', 'xsd', 'xsl', 'plist', 'wsf', 'svg',
  'yaml', 'yml',
]);

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
  if (!lang || !REGISTERED_HIGHLIGHT_LANGUAGES.has(lang)) return undefined;
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
