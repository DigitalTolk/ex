#!/usr/bin/env node
// The frontend suite (jsdom + the three browser projects) in shards, one
// after another, then merged so the 100% coverage gate (vitest.config.ts
// thresholds) applies to the combined report. One run of every file at once
// saturated the machine: slower overall, and timing-sensitive tests failed
// under that load.
//
//   node scripts/test-frontend.mjs [--shards 4] [--only N]
//
// --only N runs shard N alone and leaves its blob report for a later merge
// (`npx vitest --mergeReports --coverage`) — how CI runs it, a shard a runner.
//
// A shard whose BROWSER died (the page closed, or never became ready) has no
// verdict on any of its tests: it runs once more, and says so. A shard whose
// tests failed does not — a test that fails only sometimes is a failing test
// (CLAUDE.md, "No flaky tests"). Any console output from a test fails the run
// too (CLAUDE.md, "Zero warnings").
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    shards: { type: 'string', default: '4' },
    only: { type: 'string' },
  },
});
const count = Math.max(1, Number.parseInt(opts.shards, 10) || 1);
const only = opts.only ? Number.parseInt(opts.only, 10) : undefined;

const BROWSER_DIED = /VITEST_BROWSER_CONNECTION_CLOSED|Browser connection was closed|did not become ready within/;
const CONSOLE_LINE = /^(stderr|stdout) \|/m;

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const tee = (stream) => (chunk) => {
      output += chunk;
      stream.write(chunk);
    };
    child.stdout.on('data', tee(process.stdout));
    child.stderr.on('data', tee(process.stderr));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

function shardArgs(i) {
  return [
    'vitest', 'run', '--coverage', `--shard=${i}/${count}`, '--reporter=default', '--reporter=blob',
    // A shard's coverage is part of the whole; the merge is what is gated.
    '--coverage.thresholds.statements=0', '--coverage.thresholds.branches=0',
    '--coverage.thresholds.functions=0', '--coverage.thresholds.lines=0',
  ];
}

const failures = [];
let consoleOutput = false;
if (only === undefined) rmSync('.vitest/blob', { recursive: true, force: true });
for (const i of only === undefined ? Array.from({ length: count }, (_, k) => k + 1) : [only]) {
  console.log(`\n--- shard ${i}/${count}`);
  let result = await run(shardArgs(i));
  if (result.code !== 0 && BROWSER_DIED.test(result.output)) {
    console.log(`\n--- shard ${i}/${count}: the browser died (no test verdict); running the shard once more`);
    result = await run(shardArgs(i));
  }
  if (result.code !== 0) failures.push(`shard ${i}/${count}`);
  if (CONSOLE_LINE.test(result.output)) consoleOutput = true;
}

if (only === undefined) {
  console.log('\n--- merged');
  const merged = await run(['vitest', '--mergeReports', '--coverage']);
  if (merged.code !== 0) failures.push('merge (coverage gate)');
}

if (consoleOutput) {
  console.error('\nvitest emitted console output; keep tests quiet before passing make check');
  failures.push('console output');
}
if (failures.length > 0) {
  console.error(`\nfrontend tests failed: ${failures.join(', ')}`);
  process.exit(1);
}
