import { afterEach, beforeEach, expect } from 'vitest';

type ConsoleLevel = 'error' | 'warn';

type ConsoleCall = {
  level: ConsoleLevel;
  args: unknown[];
};

const allowedWarnings = [
  (args: unknown[]) => typeof args[0] === 'string' && args[0].startsWith('Using CodeNode without CodeExtension'),
];

const originalConsole = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
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
    calls.push({ level: 'error', args });
  };
  console.warn = (...args: unknown[]) => {
    if (allowedWarnings.some((allow) => allow(args))) return;
    calls.push({ level: 'warn', args });
  };
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
}
