// Single-retry policy for contention-flaky test files (issue #1419, umbrella #1412 Track B).
//
// Some unit-test files stub a real binary and then spawn or wait on it, so under
// host load their production code takes a generic timeout path and the file
// fails for a reason that has nothing to do with the diff (AGENTS.md, "Known
// environment traps"). Rerunning the whole suite hides real regressions and
// burns runner minutes, so the policy is deliberately narrow:
//
//   - the retry set is ENUMERATED here, never a glob: a glob would silently
//     enroll every future file under a directory,
//   - only timeout-shaped failures retry; an assertion failure in a listed file
//     fails the job on the first run,
//   - one retry, of the failed files only, and every retry is reported in the
//     job summary so a permanently flaky file cannot hide behind a green check,
//   - each entry is an owned waiver in the ADR 0011 sense: a tracking issue plus
//     a review date, and an expired entry fails the gate until it is renewed or
//     removed.

/** One enumerated retry-eligible file, owned like an ADR 0011 waiver. */
export type ContentionRetryEntry = {
  /** Repo-relative test file path. Exact path — never a glob. */
  file: string;
  /**
   * Why this file spawns or waits. Required: the retry list may only grow with a
   * concrete contention mechanism named at the entry, not by habit.
   */
  reason: string;
  /** Issue tracking the removal of the underlying real-time wait. */
  trackingIssue: string;
  /** ISO date (YYYY-MM-DD). Past this, the gate fails until renewed or removed. */
  reviewBy: string;
  /**
   * True for files that also run serialized in the `subprocess-stub` Vitest
   * project: they stub a binary on PATH, so two of them running at once race
   * over the same stub budget. Serialization bounds that contention; it does not
   * remove the real waits, which is why they are retry-eligible too.
   */
  serializedStub?: true;
};

const SUBPROCESS_STUB_ISSUE = 'https://github.com/callstack/agent-device/issues/1098';
const CONTENTION_ISSUE = 'https://github.com/callstack/agent-device/issues/1419';
const FUZZ_ISSUE = 'https://github.com/callstack/agent-device/issues/1414';
const REVIEW_BY = '2026-10-31';

/**
 * The retry-eligible set: every `SUBPROCESS_STUB_TESTS` file (vitest.config.ts —
 * serializing them bounds contention but does not remove the real waits) plus
 * the repeat offenders observed failing timeout-shaped on unrelated diffs.
 * `contention-retry-policy.test.ts` asserts the subprocess-stub half stays in
 * sync with the vitest projects.
 */
export const CONTENTION_RETRY_FILES: readonly ContentionRetryEntry[] = [
  {
    file: 'src/platforms/android/__tests__/app-lifecycle-install.test.ts',
    reason: 'Stubs adb on PATH and spawns it per case, waiting real install retry/poll time.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/android/__tests__/app-lifecycle-open.test.ts',
    reason: 'Stubs adb on PATH and spawns it, waiting real activity-launch poll time.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/android/__tests__/device-input-state.test.ts',
    reason: 'Stubs adb on PATH and spawns it, waiting real input-state poll time.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/android/__tests__/input-actions.test.ts',
    reason: 'Stubs adb on PATH and spawns it once per input action, waiting real retry time.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/android/__tests__/notifications.test.ts',
    reason: 'Stubs adb on PATH and spawns it, waiting real shade-settle poll time.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/android/__tests__/settings.test.ts',
    reason: 'Stubs adb on PATH and spawns it, waiting real settings-apply poll time.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/daemon/__tests__/runtime-hints.test.ts',
    reason: 'Stubs platform binaries on PATH and spawns them to derive runtime hints.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/apple/core/__tests__/apps.test.ts',
    reason: 'Stubs xcrun/simctl on PATH and spawns them, waiting real app-state poll budgets.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/apple/core/__tests__/interactions.test.ts',
    reason: 'Stubs xcrun/simctl on PATH and spawns them, waiting real interaction settle budgets.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/apple/core/__tests__/simulator.test.ts',
    reason: 'Stubs xcrun/simctl on PATH and spawns them, waiting real boot-poll budgets.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/apple/core/__tests__/physical-device-screenshot.test.ts',
    reason: 'Stubs devicectl on PATH and spawns it, waiting real capture budgets.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/apple/core/__tests__/screenshot.test.ts',
    reason: 'Stubs xcrun/simctl on PATH and spawns them, waiting real capture budgets.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/apple/core/__tests__/screenshot-status-bar.test.ts',
    reason: 'Stubs xcrun/simctl on PATH and spawns them, waiting real status-bar override time.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/platforms/apple/core/__tests__/devicectl.test.ts',
    reason: 'Stubs devicectl on PATH and spawns it, waiting real device-poll budgets.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/__tests__/client-metro.test.ts',
    reason: 'Stubs npx plus the package managers and spawns a real Metro dev server per case.',
    trackingIssue: SUBPROCESS_STUB_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'scripts/fuzz/harness.test.ts',
    reason: 'Spawns a node subprocess or worker per case; one target hangs on purpose (#1414).',
    trackingIssue: FUZZ_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'scripts/fuzz/corpus-replay.test.ts',
    reason: 'Replays the fuzz corpus through the worker watchdog, waiting its per-case budget.',
    trackingIssue: FUZZ_ISSUE,
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'scripts/repo-health/run.test.ts',
    reason: 'Spawns the repo-health CLI over the real tree and waits for it to exit (#1423).',
    trackingIssue: 'https://github.com/callstack/agent-device/issues/1423',
    reviewBy: REVIEW_BY,
    serializedStub: true,
  },
  {
    file: 'src/daemon/__tests__/request-router-open.test.ts',
    reason: 'Drives real open routing over keyed locks, waiting on lock/session settle budgets.',
    trackingIssue: CONTENTION_ISSUE,
    reviewBy: REVIEW_BY,
  },
  {
    file: 'src/platforms/apple/core/__tests__/runner-client.test.ts',
    reason: 'Drives runner transport connect/retry against a real socket, waiting retry backoff.',
    trackingIssue: CONTENTION_ISSUE,
    reviewBy: REVIEW_BY,
  },
  {
    file: 'src/platforms/apple/core/__tests__/runner-xctestrun.test.ts',
    reason: 'Stubs xcodebuild on PATH and spawns it for xctestrun preparation and cache checks.',
    trackingIssue: CONTENTION_ISSUE,
    reviewBy: REVIEW_BY,
  },
  {
    file: 'scripts/__tests__/help-conformance-bench.test.ts',
    reason: 'Spawns the real bench script per case in --dry-run mode and waits for it to exit.',
    trackingIssue: CONTENTION_ISSUE,
    reviewBy: REVIEW_BY,
  },
];

/**
 * The `subprocess-stub` Vitest project's file set, derived from the one list so
 * the retry policy and the execution contract cannot drift apart.
 * `vitest.config.ts` consumes this for both the unit-core exclude and the
 * subprocess-stub include.
 */
export const SUBPROCESS_STUB_TESTS: readonly string[] = CONTENTION_RETRY_FILES.filter(
  (entry) => entry.serializedStub,
).map((entry) => entry.file);

function isRetryEligibleFile(file: string): boolean {
  return CONTENTION_RETRY_FILES.some((entry) => entry.file === normalizeTestFile(file));
}

/** Absolute or `./`-prefixed paths arrive from reporters; the list is repo-relative. */
export function normalizeTestFile(file: string, repoRoot?: string): string {
  let normalized = file.replaceAll('\\', '/');
  if (repoRoot) {
    const prefix = `${repoRoot.replaceAll('\\', '/').replace(/\/$/, '')}/`;
    if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
  }
  return normalized.replace(/^\.\//, '');
}

/** Entries whose review date has passed, in list order. */
export function expiredRetryEntries(now: Date): readonly ContentionRetryEntry[] {
  const today = now.toISOString().slice(0, 10);
  return CONTENTION_RETRY_FILES.filter((entry) => entry.reviewBy < today);
}

// Vitest reports a timeout as a plain Error with a fixed message shape; there is
// no structured signal on the JSON reporter's `failureMessages`, so this is an
// owned exception to the repo's "typed signals over message sniffing" rule and
// stays confined to this classifier. Erring towards "not a timeout" is the safe
// direction: it fails the job on the first run.
const TIMEOUT_SHAPED = [
  /\btest timed out in \d+\s*ms\b/i,
  /\bhook timed out in \d+\s*ms\b/i,
  /\bclosing timeout\b/i,
  /\bETIMEDOUT\b/,
];

export function isTimeoutShapedFailure(message: string): boolean {
  return TIMEOUT_SHAPED.some((pattern) => pattern.test(message));
}

/** One failed test case as read from a runner report. */
export type TestFailure = {
  file: string;
  testName: string;
  message: string;
};

/**
 * Failures from Vitest's JSON reporter, narrowed at the trust boundary. A run
 * that dies before writing a report parses to zero failures, which the policy
 * reads as "nothing retry-eligible": the job fails, the safe direction.
 */
export function parseVitestFailures(report: unknown, repoRoot?: string): readonly TestFailure[] {
  const suites = (report as { testResults?: unknown }).testResults;
  if (!Array.isArray(suites)) return [];
  return suites.flatMap((suite) => suiteFailures(suite, repoRoot));
}

function suiteFailures(suite: unknown, repoRoot: string | undefined): TestFailure[] {
  const { name, assertionResults } = suite as { name?: unknown; assertionResults?: unknown };
  if (typeof name !== 'string' || !Array.isArray(assertionResults)) return [];
  const file = normalizeTestFile(name, repoRoot);
  return assertionResults
    .map((assertion) => assertionFailure(file, assertion))
    .filter((failure) => failure !== undefined);
}

function assertionFailure(file: string, assertion: unknown): TestFailure | undefined {
  const { status, fullName, failureMessages } = assertion as {
    status?: unknown;
    fullName?: unknown;
    failureMessages?: unknown;
  };
  if (status !== 'failed') return undefined;
  const messages = Array.isArray(failureMessages) ? failureMessages : [];
  return {
    file,
    testName: typeof fullName === 'string' ? fullName : 'unknown test',
    message: messages.filter((message) => typeof message === 'string').join('\n'),
  };
}

export type RetryPlan =
  | { retry: false; reason: string; blocked: readonly TestFailure[] }
  | { retry: true; files: readonly string[]; failures: readonly TestFailure[] };

/**
 * Decide whether a failed run may retry. Retry requires *every* failure to be a
 * timeout in a listed file: one assertion failure anywhere fails the job, so a
 * real regression can never be papered over by a rerun.
 */
export function planContentionRetry(failures: readonly TestFailure[]): RetryPlan {
  if (failures.length === 0) {
    return { retry: false, reason: 'no test failures to retry', blocked: [] };
  }
  const blocked = failures.filter(
    (failure) => !isRetryEligibleFile(failure.file) || !isTimeoutShapedFailure(failure.message),
  );
  if (blocked.length > 0) {
    const assertionShaped = blocked.filter((failure) => isRetryEligibleFile(failure.file));
    return {
      retry: false,
      reason:
        assertionShaped.length > 0
          ? 'a listed file failed for a non-timeout reason (assertion failures never retry)'
          : 'a failure landed outside the enumerated retry list',
      blocked,
    };
  }
  const files = [...new Set(failures.map((failure) => normalizeTestFile(failure.file)))].sort();
  return { retry: true, files, failures };
}

export type RetryOutcome = 'passed' | 'failed';

export type RetrySummaryInput = {
  plan: RetryPlan;
  outcome?: RetryOutcome;
};

/** Markdown for the job summary: every retried file is named, always. */
export function formatRetrySummary({ plan, outcome }: RetrySummaryInput): string {
  const lines = ['## Contention retry (#1419)', ''];
  if (!plan.retry) {
    lines.push(`No retry: ${plan.reason}.`, '');
    for (const failure of plan.blocked) {
      lines.push(`- \`${normalizeTestFile(failure.file)}\` — ${failure.testName}`);
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }
  lines.push(
    `Retried ${plan.files.length} timeout-shaped file(s) once — outcome: **${outcome ?? 'pending'}**.`,
    '',
    '| File | Failing test | Tracking issue | Review by |',
    '| --- | --- | --- | --- |',
  );
  for (const failure of plan.failures) {
    const file = normalizeTestFile(failure.file);
    const entry = CONTENTION_RETRY_FILES.find((candidate) => candidate.file === file);
    lines.push(
      `| \`${file}\` | ${failure.testName} | ${entry?.trackingIssue ?? '—'} | ${entry?.reviewBy ?? '—'} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
