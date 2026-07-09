// Browser-universe gate: after the browser coverage run, every runtime src
// file that is NOT excluded in vitest.browser.config.ts must actually appear
// in the produced lcov. This is the "no file silently ungraded" guarantee for
// the browser suite, implemented as a post-run check instead of vitest-4's
// coverage.include universe (which statically double-instruments modules also
// loaded through vi.mock(importOriginal) and corrupts the merged report).
//
// Combined with scripts/check-coverage-partition.mjs (nothing excluded from
// BOTH suites), the two suites always grade the whole codebase.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const lcovPath = join(root, 'coverage-browser', 'lcov.info');

if (!existsSync(lcovPath)) {
  console.error('browser-universe: coverage-browser/lcov.info missing — run the browser coverage suite first');
  process.exit(1);
}

function parseExcludes(configPath) {
  const src = readFileSync(join(root, configPath), 'utf8');
  // Anchor on the coverage block — the configs also carry a test-spec
  // `exclude` array that must not be confused with the coverage one.
  const cov = src.slice(src.indexOf('coverage:'));
  const m = cov.match(/exclude:\s*\[([^\]]*)\]/s);
  if (!m) throw new Error(`${configPath}: could not find coverage exclude list`);
  // Strip line comments first — apostrophes inside them ("vitest's") would
  // de-sync the quote pairing and silently drop real entries.
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function matches(pattern, file) {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, ' ')
        .replace(/\*/g, '[^/]*')
        .replace(/ /g, '.*') +
      '$',
  );
  return re.test(file);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(relative(root, p));
    }
  }
  return out;
}

const excludes = parseExcludes('vitest.browser.config.ts');
const graded = new Set(
  readFileSync(lcovPath, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('SF:'))
    .map((l) => l.slice(3).trim())
    .map((p) => (p.startsWith('/') ? relative(root, p) : p)),
);

const expected = walk(join(root, 'src')).filter(
  (f) =>
    !f.includes('.test.') &&
    !f.startsWith('src/test/') &&
    !f.includes('__mocks__') &&
    !f.includes('__screenshots__') &&
    !excludes.some((p) => matches(p, f)),
);

const missing = expected.filter((f) => !graded.has(f));

if (missing.length > 0) {
  for (const f of missing) {
    console.error(
      `browser-universe: ${f} is in the browser coverage universe but absent from lcov — no browser test loads it. Add a test that exercises it, or (if the jsdom gate grades it) add it to the browser exclude list with a pointer comment.`,
    );
  }
  process.exit(1);
}

console.log(`browser-universe: OK — all ${expected.length} non-excluded src files are present in the browser coverage report`);
