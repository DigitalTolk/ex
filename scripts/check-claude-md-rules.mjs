// Self-test for the CLAUDE.md content gate: given a gitleaks JSON report of
// the known-bad fixture (scripts/testdata/claude-md-gate/violations.md) and
// the custom rule ids, fail unless every rule caught something — a rule that
// silently stops matching would otherwise pass the real file forever.
//
//   node scripts/check-claude-md-rules.mjs <report.json> <rule-id>...
import { readFileSync } from 'node:fs';

const [reportPath, ...rules] = process.argv.slice(2);
const found = new Set(JSON.parse(readFileSync(reportPath, 'utf8')).map((f) => f.RuleID));
const missing = rules.filter((r) => !found.has(r));
if (missing.length > 0) {
  console.error(`CLAUDE.md gate: rules no longer catch the known-bad fixture: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`CLAUDE.md gate: all ${rules.length} rules catch the known-bad fixture`);
