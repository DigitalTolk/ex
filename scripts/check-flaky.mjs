#!/usr/bin/env node
// Flake gate. Runs the frontend tests a change touches several times over, in
// a shuffled order, at different local hours, and with runs side by side to
// load the machine, and fails if any run fails. A test that passes once on a
// quiet machine but not under CI's load, in another order or at another time
// of day is caught here, before it lands.
//
//   node scripts/check-flaky.mjs [--base <ref>] [--rounds N] [--parallel N] [--seed N] [file ...]
//
// Without files, the tests touched are those changed since the merge base
// with --base (default: main), uncommitted and untracked ones included, plus,
// for each changed source file, the tests named after it (Foo.tsx →
// Foo.test.tsx, Foo.browser.test.tsx, Foo.<topic>.test.tsx) and the tests
// importing it (unless so many do that the run would be the whole suite).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { zoneWhereLocalHourIs } from './local-hour-zone.mjs';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'main' },
    rounds: { type: 'string', default: '4' },
    parallel: { type: 'string', default: '2' },
    seed: { type: 'string' },
  },
});
const rounds = Math.max(1, Number.parseInt(opts.rounds, 10) || 1);
const parallel = Math.max(1, Math.min(rounds, Number.parseInt(opts.parallel, 10) || 1));
const firstSeed = opts.seed ? Number.parseInt(opts.seed, 10) : Date.now() % 1_000_000;

// More importers than this and a changed module is shared plumbing (the API
// client, a context): its own tests stand for it, not the whole suite.
const MAX_IMPORTERS = 12;
const TEST_FILE = /\.(test|spec)\.tsx?$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const lines = (out) => out.split('\n').filter(Boolean);

function allTestFiles(dir = 'src') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allTestFiles(p));
    else if (TEST_FILE.test(entry.name)) out.push(p);
  }
  return out;
}

function touchedTests() {
  const mergeBase = git('merge-base', 'HEAD', opts.base);
  const changed = [
    ...lines(git('diff', '--name-only', '--diff-filter=d', mergeBase)),
    ...lines(git('ls-files', '--others', '--exclude-standard')),
  ].filter((f) => f.startsWith('src/') && /\.tsx?$/.test(f) && existsSync(f));
  const tests = new Set(changed.filter((f) => TEST_FILE.test(f)));
  const everyTest = allTestFiles();
  for (const file of changed.filter((f) => !TEST_FILE.test(f))) {
    const dir = path.dirname(file);
    const stem = path.basename(file).replace(/\.tsx?$/, '');
    for (const name of readdirSync(dir)) {
      if (TEST_FILE.test(name) && (name.startsWith(`${stem}.`))) tests.add(path.join(dir, name));
    }
    const specifier = `@/${file.slice('src/'.length).replace(/\.tsx?$/, '').replace(/\/index$/, '')}`;
    const quoted = [`'${specifier}'`, `"${specifier}"`];
    const importers = everyTest.filter((t) => {
      const text = readFileSync(t, 'utf8');
      return quoted.some((q) => text.includes(q));
    });
    if (importers.length <= MAX_IMPORTERS) for (const t of importers) tests.add(t);
    else console.log(`check-flaky: ${file} is imported by ${importers.length} tests; running only the ones named after it`);
  }
  return [...tests].sort();
}

const files = positionals.length > 0 ? positionals : touchedTests();
if (files.length === 0) {
  console.log('check-flaky: no frontend tests touched');
  process.exit(0);
}
console.log(`check-flaky: ${files.length} test file(s), ${rounds} shuffled round(s), ${parallel} at a time`);
for (const f of files) console.log(`  ${f}`);

// The time zone each round runs in (TZ; vitest.config.ts hands it to the
// browsers too), picked from the clock so local time is just before midnight
// in one round and just past it in another, then midday and a zone with
// daylight saving: a test that only passes at some hours fails here, in a
// known round, instead of one night in CI.
const zones = [zoneWhereLocalHourIs(23), zoneWhereLocalHourIs(0), zoneWhereLocalHourIs(12), 'America/Los_Angeles'];

function runRound({ seed, zone }) {
  return new Promise((resolve) => {
    const args = ['vitest', 'run', '--sequence.shuffle', `--sequence.seed=${seed}`, ...files];
    const env = { ...process.env, TZ: zone, NO_COLOR: '1', FORCE_COLOR: '0' };
    const child = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code) => resolve({ seed, zone, code, output }));
  });
}

const plan = Array.from({ length: rounds }, (_, i) => ({ seed: firstSeed + i, zone: zones[i % zones.length] }));
const failed = [];
for (let i = 0; i < plan.length; i += parallel) {
  const results = await Promise.all(plan.slice(i, i + parallel).map(runRound));
  for (const r of results) {
    const summary = r.output.match(/^\s*Tests\s+.*$/m)?.[0].trim() ?? 'no summary';
    console.log(`  seed ${r.seed}, TZ ${r.zone}: ${r.code === 0 ? 'passed' : 'FAILED'} (${summary})`);
    if (r.code !== 0) failed.push(r);
  }
}

if (failed.length > 0) {
  for (const r of failed) {
    const start = r.output.search(/Failed Tests|FAIL\s/);
    console.error(`\n--- seed ${r.seed}, TZ ${r.zone} ---\n${(start >= 0 ? r.output.slice(start) : r.output).slice(0, 8000)}`);
    console.error(`reproduce: TZ=${r.zone} npx vitest run --sequence.shuffle --sequence.seed=${r.seed} ${files.join(' ')}`);
  }
  console.error(`\ncheck-flaky: ${failed.length} of ${rounds} round(s) failed — a test that fails under load, in another order or at another hour is flaky; fix the cause, do not retry it away`);
  process.exit(1);
}
console.log('check-flaky: every round passed');
