// People-facing names for what a runner reports about its computer.

const OS_LABELS: Record<string, string> = { darwin: 'macOS', linux: 'Linux', windows: 'Windows' };
const HARNESS_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

export function osLabel(os: string): string {
  return OS_LABELS[os] ?? os;
}

export function harnessLabel(name: string): string {
  return HARNESS_LABELS[name] ?? name;
}

// harnessVersion trims what a CLI prints for --version ("2.1.223 (Claude
// Code)", "codex-cli 0.147.0") to the version number; anything without one
// passes through.
export function harnessVersion(raw: string): string {
  return raw.match(/\d+(?:\.\d+)+/)?.[0] ?? raw;
}
