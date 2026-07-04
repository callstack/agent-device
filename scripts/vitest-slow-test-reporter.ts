import type { Reporter, TestCase, TestModule } from 'vitest/node';

/**
 * Slow-test ratchet (see docs/agents/testing.md "Speed rules").
 *
 * Unit tests must not wait real time: measured 2026-07-04, the unit suite's
 * wall clock was bounded by files whose tests slept through production
 * timeouts (a 10.8s test proving "times out" by waiting the full 10s budget).
 * This reporter fails the run when a unit test exceeds the budget UNLESS it
 * is pinned below. The pin is a ratchet: it may only shrink, or grow in the
 * same PR that adds the entry here with a justification — the same
 * only-changes-in-reviewed-diffs rule as the guarantee-matrix gap list.
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

// Ratchet pin: known offenders at gate introduction (tracking issue #1098).
// Every entry is a test that waits real time (production timeout constants,
// 1Hz poll loops, real retry backoff) and shrinks as those are converted to
// budget-wiring assertions or budget-derived poll intervals.
const PINNED_SLOW_UNIT_TESTS = new Set([
  "src/__tests__/daemon-entrypoint.test.ts :: daemon runtime starts HTTP transport in-process and shuts down cleanly",
  "src/daemon/__tests__/artifact-materialization.test.ts :: materializeArtifact extracts iOS app bundle tar archives and returns the installable .app path",
  "src/daemon/__tests__/runtime-hints.test.ts :: applyRuntimeHintsToApp preserves write failures after a successful run-as probe",
  "src/daemon/__tests__/runtime-hints.test.ts :: applyRuntimeHintsToApp writes React Native Android dev prefs",
  "src/daemon/__tests__/runtime-hints.test.ts :: applyRuntimeHintsToApp writes iOS simulator React Native defaults",
  "src/daemon/__tests__/runtime-hints.test.ts :: clearRuntimeHintsFromApp removes managed Android runtime prefs but preserves unrelated entries",
  "src/daemon/handlers/__tests__/session-replay-vars.test.ts :: runReplayScriptFile skips Maestro runFlow.when.visible commands when absent",
  "src/platforms/__tests__/install-source.test.ts :: prepareIosInstallArtifact cleans URL materialization when IPA payload resolution fails",
  "src/platforms/__tests__/install-source.test.ts :: prepareIosInstallArtifact extracts trusted GitHub artifact ZIP containing nested app tar",
  "src/platforms/__tests__/install-source.test.ts :: prepareIosInstallArtifact extracts trusted GitHub artifact ZIP containing one IPA",
  "src/platforms/android/__tests__/devices.test.ts :: ensureAndroidEmulatorBooted falls back to ANDROID_SDK_ROOT when PATH is incomplete",
  "src/platforms/android/__tests__/devices.test.ts :: ensureAndroidEmulatorBooted launches emulator in headless mode when requested",
  "src/platforms/android/__tests__/devices.test.ts :: ensureAndroidEmulatorBooted launches emulator with GUI by default",
  "src/platforms/android/__tests__/devices.test.ts :: ensureAndroidEmulatorBooted reuses running emulator for headless requests",
  "src/platforms/android/__tests__/devices.test.ts :: listAndroidDevices falls back to model when emulator avd name is unavailable",
  "src/platforms/android/__tests__/index.test.ts :: fillAndroid uses chunk-safe shell input and retries when verification still fails",
  "src/platforms/android/__tests__/index.test.ts :: installAndroidApp .aab reports missing bundletool tooling",
  "src/platforms/android/__tests__/index.test.ts :: installAndroidApp installs .aab via bundletool build-apks + install-apks",
  "src/platforms/android/__tests__/index.test.ts :: installAndroidApp installs .apk via adb install -r",
  "src/platforms/android/__tests__/index.test.ts :: installAndroidApp resolves packageName and launchTarget from nested archive artifacts",
  "src/platforms/android/__tests__/perf.test.ts :: stopAndroidSimpleperfProfile fails before pull when remote artifact never stabilizes",
  "src/platforms/android/__tests__/snapshot-helper-session.test.ts :: allows a persistent session snapshot to use the helper command budget",
  "src/platforms/apple/core/__tests__/index.test.ts :: openIosSimulatorApp times out instead of hanging indefinitely",
  "src/platforms/apple/core/__tests__/index.test.ts :: prepareSimulatorStatusBarForScreenshot restores prior visible overrides",
  "src/platforms/apple/core/__tests__/index.test.ts :: prepareSimulatorStatusBarForScreenshot skips known redundant status bar commands",
  "src/platforms/apple/core/__tests__/index.test.ts :: prepareSimulatorStatusBarForScreenshot still normalizes when snapshotting current overrides fails",
  "src/platforms/apple/core/__tests__/index.test.ts :: screenshotIos retries simulator capture timeouts and eventually succeeds",
  "src/platforms/apple/core/__tests__/runner-adoption.test.ts :: adoption is skipped on artifact fingerprint mismatch",
  "src/platforms/apple/core/__tests__/runner-adoption.test.ts :: adoption is skipped when the probe fails",
  "src/platforms/apple/core/__tests__/runner-client.test.ts :: ensureXctestrun falls back to scan when cache manifest is stale",
  "src/platforms/apple/core/__tests__/runner-client.test.ts :: ensureXctestrun rebuilds after cached macOS runner repair failure",
  "src/platforms/apple/core/__tests__/runner-client.test.ts :: ensureXctestrun rebuilds cached runner when Swift build flags mismatch",
  "src/platforms/apple/core/__tests__/runner-client.test.ts :: ensureXctestrun rebuilds foreign artifacts when metadata does not match",
  "src/platforms/apple/core/__tests__/runner-xctestrun.test.ts :: setup metadata script matches expected iOS simulator cache metadata",
  "src/recording/__tests__/recording-scripts.test.ts :: recording overlay Swift script typechecks",
  "src/utils/__tests__/daemon-client.test.ts :: cleanupFailedDaemonStartupMetadata retains live startup daemon on timeout",
]);

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
  if (PINNED_SLOW_UNIT_TESTS.has(`${relative} :: ${params.name}`)) return null;
  if (PINNED_SLOW_UNIT_TESTS.has(fullKey)) return null;
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
      `wired instead of waiting it out (docs/agents/testing.md). If the wait is genuinely\n` +
      `irreducible, pin it in scripts/vitest-slow-test-reporter.ts in this PR with a reason.\n` +
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
