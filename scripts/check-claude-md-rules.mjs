// Self-test for the CLAUDE.md content gate, run on the gitleaks JSON report of
// the known-bad fixture. It fails unless every bullet of the fixture was
// caught and every custom rule in the config fired — so a rule that silently
// stops matching (or a new rule nobody tested) can't pass the real file
// forever. The known-good fixture is checked separately: gitleaks must report
// nothing there.
//
//   node scripts/check-claude-md-rules.mjs <config.toml> <report.json> <violations.md>
import { readFileSync } from 'node:fs';

const [configPath, reportPath, fixturePath] = process.argv.slice(2);
const rules = [...readFileSync(configPath, 'utf8').matchAll(/^id\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
const findings = JSON.parse(readFileSync(reportPath, 'utf8'));
const fired = new Set(findings.map((f) => f.RuleID));
const caughtLines = new Set(findings.map((f) => f.StartLine));

const problems = [];
const silent = rules.filter((r) => !fired.has(r));
if (silent.length > 0) problems.push(`rules that caught nothing: ${silent.join(', ')}`);
readFileSync(fixturePath, 'utf8')
  .split('\n')
  .forEach((line, i) => {
    if (line.startsWith('- ') && !caughtLines.has(i + 1)) problems.push(`line ${i + 1} not caught: ${line}`);
  });

if (problems.length > 0) {
  console.error(`CLAUDE.md gate self-test failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`CLAUDE.md gate: all ${rules.length} rules fire and every known violation is caught`);
