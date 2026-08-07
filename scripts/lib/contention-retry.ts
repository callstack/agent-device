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
//   - only tests the runner itself aborted at their timeout retry; an assertion
//     failure in a listed file fails the job on the first run,
//   - one retry, of the failed files only, and every retry is reported in the
//     job summary so a permanently flaky file cannot hide behind a green check,
//   - each entry is an owned waiver in the ADR 0011 sense: a tracking issue plus
//     a review date, and an expired entry fails the gate until it is renewed or
//     removed.

import { runnerTimedOut } from './runner-timeout-meta.ts';

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
    reason:
      'Stubs bundletool on PATH (adb is in-process) and spawns zip/unzip for .aab packaging paths.',
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
    reason:
      'Stubs unzip on PATH for .ipa extraction (xcrun is in-process) and spawns it per install case.',
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

/** An error as the lane reporter receives it from Vitest. */
export type ReportedError = {
  name?: unknown;
  message?: unknown;
  expected?: unknown;
  actual?: unknown;
};

/** A test the runner aborted at its timeout — the only failure this lane retries. */
export function isRunnerTimeout(
  errors: readonly ReportedError[],
  meta: unknown,
  token: string | undefined,
): boolean {
  return runnerTimedOut(meta, token) && errors.length > 0 && errors.every(hasNoAssertionDiff);
}

/** A timeout that also failed an assertion is a regression, not contention. */
function hasNoAssertionDiff(error: ReportedError): boolean {
  return error.expected === undefined && error.actual === undefined;
}

/** One failed test case as read from a runner report. */
export type TestFailure = {
  file: string;
  testName: string;
  message: string;
  /** Classified by the reporter from the live error object, never from text. */
  timeout: boolean;
};

/**
 * A failure that is not a failed test case — an unhandled error, a module that
 * failed to load, a coverage-threshold miss, a nonzero exit nothing else
 * explains. These can never be retried away: they block the plan outright, so a
 * timeout retry can never erase a second, unrelated failure from the same run.
 */
export type RunBlocker = { kind: string; detail: string };

/**
 * Failures as written by the lane's reporter (`contention-retry-reporter.ts`),
 * narrowed at the trust boundary. A run that dies before writing the file parses
 * to zero failures, which the policy reads as "nothing retry-eligible": the job
 * fails, the safe direction.
 */
export function parseFailureReport(
  report: unknown,
  repoRoot?: string,
): { failures: readonly TestFailure[]; blockers: readonly RunBlocker[] } {
  const { failures, blockers } = report as { failures?: unknown; blockers?: unknown };
  return {
    failures: Array.isArray(failures)
      ? failures.map((entry) => readFailure(entry, repoRoot)).filter((entry) => entry !== undefined)
      : [],
    blockers: Array.isArray(blockers)
      ? blockers.map((entry) => readBlocker(entry)).filter((entry) => entry !== undefined)
      : [],
  };
}

function readBlocker(entry: unknown): RunBlocker | undefined {
  const { kind, detail } = entry as { kind?: unknown; detail?: unknown };
  if (typeof kind !== 'string') return undefined;
  return { kind, detail: typeof detail === 'string' ? detail : '' };
}

function readFailure(entry: unknown, repoRoot: string | undefined): TestFailure | undefined {
  const { file, testName, message, timeout } = entry as Partial<Record<keyof TestFailure, unknown>>;
  if (typeof file !== 'string') return undefined;
  return {
    file: normalizeTestFile(file, repoRoot),
    testName: typeof testName === 'string' ? testName : 'unknown test',
    message: typeof message === 'string' ? message : '',
    timeout: timeout === true,
  };
}

export type RetryPlan =
  | {
      retry: false;
      reason: string;
      blocked: readonly TestFailure[];
      blockers: readonly RunBlocker[];
    }
  | { retry: true; files: readonly string[]; failures: readonly TestFailure[] };

/**
 * Decide whether a failed run may retry. Retry requires *every* failure to be a
 * timeout in a listed file: one assertion failure anywhere fails the job, so a
 * real regression can never be papered over by a rerun.
 */
export function planContentionRetry(
  failures: readonly TestFailure[],
  blockers: readonly RunBlocker[] = [],
): RetryPlan {
  if (blockers.length > 0) {
    return {
      retry: false,
      reason: `the run failed for a reason a rerun cannot re-check (${blockers
        .map((blocker) => blocker.kind)
        .join(', ')})`,
      blocked: failures,
      blockers,
    };
  }
  if (failures.length === 0) {
    return { retry: false, reason: 'no test failures to retry', blocked: [], blockers };
  }
  const blocked = failures.filter(
    (failure) => !isRetryEligibleFile(failure.file) || !failure.timeout,
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
      blockers,
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
    for (const blocker of plan.blockers) {
      lines.push(`- **${blocker.kind}** — ${blocker.detail}`);
    }
    for (const failure of plan.blocked) {
      lines.push(`- \`${normalizeTestFile(failure.file)}\` — ${failure.testName}`);
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }
  lines.push(
    `Retried ${plan.files.length} timeout-shaped file(s) once — outcome: **${outcome ?? 'pending'}**.`,
    '',
    '| File | Failing test(s) | Tracking issue | Review by |',
    '| --- | --- | --- | --- |',
  );
  for (const file of plan.files) {
    const entry = CONTENTION_RETRY_FILES.find((candidate) => candidate.file === file);
    const tests = plan.failures
      .filter((failure) => normalizeTestFile(failure.file) === file)
      .map((failure) => failure.testName)
      .join(', ');
    lines.push(
      `| \`${file}\` | ${tests} | ${entry?.trackingIssue ?? '—'} | ${entry?.reviewBy ?? '—'} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
