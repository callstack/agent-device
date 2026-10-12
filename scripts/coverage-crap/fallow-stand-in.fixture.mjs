// A stand-in for `fallow health --format json`, for the cases that need a finding of their own
// choosing rather than one this repository's real fallow happens to report. It answers from
// `coverage/fallow-stand-in.json` in the working directory — that is the fixture repo — so a case
// says what it wants reported by writing a file. With no fixture it reports no findings: inventing a
// debt finding here would let a case that wrote its fixture to the wrong path pass on the wrong
// reason, which is the failure this file exists to make visible.
//
// It also records the flags it was called with, because `--diff-file` is what scopes scoring to the
// diff. Losing it would quietly widen every PR verdict to the whole repo, and a passing exit code
// would not notice.
import fs from 'node:fs';

// A coverage run records functions, not arrow values, so a report that names one as absent from the
// map is an estimate. That is the difference the two estimated cases need.
const MEASURED = { cyclomatic: 6, coverage_pct: 0, coverage_source: 'istanbul' };
const ESTIMATED = { cyclomatic: 9, coverage_pct: null, coverage_source: 'estimated' };

const argv = process.argv.slice(2);
const flagValue = (flag) => (argv.includes(flag) ? (argv[argv.indexOf(flag) + 1] ?? null) : null);

if (argv[0] === 'config') {
  process.stdout.write(JSON.stringify({ health: { thresholdOverrides: [] } }));
  process.exit(0);
}

let finding = null;
try {
  finding = JSON.parse(fs.readFileSync('coverage/fallow-stand-in.json', 'utf8'))[0];
} catch {
  // No fixture: an empty report, which no blocking case can mistake for its own finding.
}

fs.writeFileSync(
  'coverage/fallow-stand-in-called-with.json',
  JSON.stringify({
    diffFile: flagValue('--diff-file'),
    coverage: flagValue('--coverage'),
    reportOnly: argv.includes('--report-only'),
  }),
);
const findings =
  finding === null
    ? []
    : [{ ...(finding.coverage_source === 'estimated' ? ESTIMATED : MEASURED), ...finding }];
process.stdout.write(
  JSON.stringify({ kind: 'health', schema_version: 11, version: '3.32.0-standin', findings }),
);
