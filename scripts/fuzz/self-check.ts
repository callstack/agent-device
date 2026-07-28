// `pnpm fuzz:parsers --self-check` — proves the harness can still fail (#1414).
//
// Runs each broken-on-purpose target through the same worker/watchdog path a real case takes
// and asserts the expected failure kind comes back. Inverted expectations are the point: this
// mode fails when the harness reports nothing.

import type { FuzzTargetRun } from './envelope.ts';
import { runCases } from './execute.ts';
import { describeFailure } from './invariant.ts';
import type { FuzzOptions } from './options.ts';
import { SELF_CHECK_EXPECTATIONS, SELF_CHECK_TARGETS } from './self-check-targets.ts';
import type { SelfCheckTargetName } from './target-types.ts';

type SelfCheckResult = {
  target: string;
  expected: string;
  actual: string;
  ok: boolean;
  durationMs: number;
};

/** Runs every self-check target once; `caseTimeoutMs` also bounds the hang target. */
async function selfCheckResults(caseTimeoutMs: number): Promise<SelfCheckResult[]> {
  const results: SelfCheckResult[] = [];
  for (const target of SELF_CHECK_TARGETS) {
    const expected = SELF_CHECK_EXPECTATIONS[target.name as SelfCheckTargetName];
    const started = Date.now();
    const failures = await runCases(target, [...target.seeds], caseTimeoutMs);
    const actual = failures[0] ? failures[0].kind : 'none';
    results.push({
      target: target.name,
      expected,
      actual,
      ok: actual === expected,
      durationMs: Date.now() - started,
    });
    if (failures[0]) process.stdout.write(`  ${describeFailure(failures[0])}\n`);
  }
  return results;
}

/** Runs the self-check and reports per-target rows for the run envelope. */
export async function runSelfCheck(
  options: FuzzOptions,
): Promise<{ ok: boolean; targetRuns: FuzzTargetRun[] }> {
  process.stdout.write('Self-check: the harness must catch each seeded violation.\n');
  const results = await selfCheckResults(options.caseTimeoutMs);
  for (const result of results) {
    process.stdout.write(
      `${result.ok ? 'ok  ' : 'FAIL'} ${result.target}: expected ${result.expected}, got ${result.actual}\n`,
    );
  }
  return {
    ok: results.every((result) => result.ok),
    targetRuns: results.map((result) => ({
      target: result.target,
      cases: 1,
      failures: result.ok ? 1 : 0,
      durationMs: result.durationMs,
    })),
  };
}
