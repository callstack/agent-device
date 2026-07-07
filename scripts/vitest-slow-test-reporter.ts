import type { Reporter, TestCase, TestModule } from 'vitest/node';

/**
 * Slow-test ratchet (see docs/agents/testing.md "Speed rules").
 *
 * Unit tests must not wait real time: measured 2026-07-04, the unit suite's
 * wall clock was bounded by files whose tests slept through production
 * timeouts (a 10.8s test proving "times out" by waiting the full 10s budget).
 * This reporter fails the run when a unit test exceeds the enforced budget.
 *
 * Budgets are per suite family: integration scenarios drive a real daemon
 * request path and get more room; unit tests get 2.5s, which is already
 * generous for injected-time tests.
 */
const UNIT_BUDGET_MS = 2_500;
const INTEGRATION_BUDGET_MS = 15_000;
// Enforcement fires at 2x budget: host load legitimately stretches a
// borderline test by tens of percent, and a wall-clock gate that flakes under
// contention trains people to ignore it. Between budget and 2x budget the
// gate reports without failing.
const ENFORCE_FACTOR = 2;

type Offender = { key: string; durationMs: number; budgetMs: number; enforce: boolean };

function budgetForPath(relativePath: string): number {
  return relativePath.startsWith('src/') ? UNIT_BUDGET_MS : INTEGRATION_BUDGET_MS;
}

/**
 * Classify one finished test against its budget. Exported for the unit test —
 * the reporter shell below is a thin vitest-callback adapter around this.
 */
export function classifySlowTest(params: {
  root: string;
  moduleId: string;
  name: string;
  fullName: string;
  durationMs: number;
}): Offender | null {
  const relative =
    params.root && params.moduleId.startsWith(params.root)
      ? params.moduleId.slice(params.root.length + 1)
      : params.moduleId;
  const budgetMs = budgetForPath(relative);
  if (params.durationMs <= budgetMs) return null;
  const fullKey = `${relative} :: ${params.fullName.split(' > ').join(' ')}`;
  return {
    key: fullKey,
    durationMs: params.durationMs,
    budgetMs,
    enforce: params.durationMs > budgetMs * ENFORCE_FACTOR,
  };
}

/** Render the gate outcome; returns true when the run must fail. */
export function reportSlowTests(
  offenders: Offender[],
  write: (message: string) => void,
): boolean {
  if (offenders.length === 0) return false;
  const sorted = [...offenders].sort((a, b) => b.durationMs - a.durationMs);
  const line = (o: Offender): string =>
    `  ${(o.durationMs / 1000).toFixed(2)}s (budget ${o.budgetMs / 1000}s)  ${o.key}`;
  const failing = sorted.filter((o) => o.enforce);
  const warning = sorted.filter((o) => !o.enforce);
  if (warning.length > 0) {
    write(
      `\nSlow-test gate: ${warning.length} test(s) over budget (within the ${ENFORCE_FACTOR}x load-variance band, not failing):\n` +
        warning.map(line).join('\n'),
    );
  }
  if (failing.length === 0) return false;
  write(
      `\nSlow-test gate: ${failing.length} test(s) exceeded ${ENFORCE_FACTOR}x the wall-clock budget.\n` +
      `Tests must not wait real time — inject the timeout/poll budget or assert the budget is\n` +
      `wired instead of waiting it out (docs/agents/testing.md). If the runtime cost is genuinely\n` +
      `irreducible, document the reason in the owning test or move it out of the unit lane.\n` +
      failing.map(line).join('\n'),
  );
  return true;
}

export default function slowTestGateReporter(): Reporter {
  const offenders: Offender[] = [];
  let root = '';
  return {
    onInit(ctx: { config: { root: string } }): void {
      root = ctx.config.root;
    },
    onTestCaseResult(testCase: TestCase): void {
      const result = testCase.result();
      if (result.state !== 'passed' && result.state !== 'failed') return;
      const offender = classifySlowTest({
        root,
        moduleId: (testCase.module as TestModule).moduleId,
        name: testCase.name,
        fullName: testCase.fullName,
        durationMs: testCase.diagnostic()?.duration ?? 0,
      });
      if (offender) offenders.push(offender);
    },
    onTestRunEnd(): void {
      // eslint-disable-next-line no-console
      if (reportSlowTests(offenders, (message) => console.error(message))) {
        process.exitCode = 1;
      }
    },
  };
}
