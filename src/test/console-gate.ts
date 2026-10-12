import { afterEach, beforeEach, expect } from 'vitest';

type ConsoleLevel = 'error' | 'warn';

type ConsoleCall = {
  level: ConsoleLevel;
  args: unknown[];
};

const allowedWarnings = [
  (args: unknown[]) => typeof args[0] === 'string' && args[0].startsWith('Using CodeNode without CodeExtension'),
];

// Benign, non-actionable browser layout notices that surface intermittently
// (when a ResizeObserver callback triggers another reflow) — e.g. popovers and
// typeahead menus that re-measure on open. Chrome/WebKit emit these as window
// error events that vitest-browser reports through console.error; they are not
// real failures, so we allow exactly these known messages (and nothing else).
const RESIZE_OBSERVER_NOISE = /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;
// Uppy reports a failed upload asynchronously; a test that drops a file into
// the composer has moved on by the time the mocked S3 answers 404, so the
// message lands in whichever test runs next. Not a failure of that test.
const UPPY_S3_NOISE = /\[Uppy\].*S3 returned 404/;
const allowedErrors = [
  (args: unknown[]) => args.some((a) => {
    const text = a instanceof Error ? a.message : typeof a === 'string' ? a : '';
    return RESIZE_OBSERVER_NOISE.test(text) || UPPY_S3_NOISE.test(text);
  }),
];

const originalConsole = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  debug: console.debug.bind(console),
};

let calls: ConsoleCall[] = [];

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function formatCall(call: ConsoleCall): string {
  return `[console.${call.level}] ${call.args.map(formatArg).join(' ')}`;
}

function installConsoleGate() {
  console.error = (...args: unknown[]) => {
    if (allowedErrors.some((allow) => allow(args))) return;
    calls.push({ level: 'error', args });
  };
  console.warn = (...args: unknown[]) => {
    if (allowedWarnings.some((allow) => allow(args))) return;
    calls.push({ level: 'warn', args });
  };
  // Silence console.debug entirely during browser tests. It is not gated (so it
  // can't fail a test) but some code paths intentionally exercised here emit
  // debug logs — notably the `ex.sidebarDndDebug`-gated sidebar DnD tracing in
  // Sidebar.tsx / useSidebar.ts, which the DnD tests turn on to cover those
  // branches. Stubbing it keeps the suite output clean without losing coverage.
  console.debug = () => {};
}

beforeEach(() => {
  calls = [];
  installConsoleGate();
});

afterEach(() => {
  const unexpected = calls;
  calls = [];
  installConsoleGate();
  expect(unexpected.map(formatCall)).toEqual([]);
});

export function restoreConsoleForDebugging() {
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.debug = originalConsole.debug;
}
