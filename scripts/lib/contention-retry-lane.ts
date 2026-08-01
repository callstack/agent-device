// Orchestration for the single-retry policy (#1419): run the suite, and when it
// fails only with timeout-shaped failures in enumerated files, rerun exactly
// those files once. Kept free of process spawning and file writing so both
// acceptance cases — an injected assertion failure fails on the first run, an
// injected timeout passes on retry — are driven directly in the gate test.

import { laneEnvelope, type LaneEnvelope } from './lane-envelope.ts';
import {
  CONTENTION_RETRY_FILES,
  expiredRetryEntries,
  formatRetrySummary,
  normalizeTestFile,
  planContentionRetry,
  type RetryOutcome,
  type RetryPlan,
  type RunBlocker,
  type TestFailure,
} from './contention-retry.ts';

export type TestRun = {
  ok: boolean;
  failures: readonly TestFailure[];
  /** Non-test failures; any of them forbids a retry. */
  blockers?: readonly RunBlocker[];
};

/** Telemetry payload written to the shared lane envelope (scripts/lib/lane-envelope.ts). */
export type ContentionRetryTelemetry = {
  /** Files rerun in this job (one entry per file, not per failed test). */
  retried: ReadonlyArray<{ file: string; testNames: readonly string[]; trackingIssue: string }>;
  retryCount: number;
  retryOutcome: RetryOutcome | null;
  listSize: number;
};

export type ContentionRetryResult = {
  ok: boolean;
  summary: string;
  envelope: LaneEnvelope<ContentionRetryTelemetry>;
};

export type ContentionRetryOptions = {
  /** Runs the whole suite. */
  runAll: () => Promise<TestRun>;
  /** Reruns exactly the given files. */
  runFiles: (files: readonly string[]) => Promise<TestRun>;
  commit: string;
  configHash: string;
  vitestVersion: string;
  startedAtMs: number;
  now?: () => number;
  /** Clock for the waiver expiry gate. */
  today?: Date;
};

const LANE_ID = 'unit-contention-retry';

export async function runWithContentionRetry(
  options: ContentionRetryOptions,
): Promise<ContentionRetryResult> {
  const today = options.today ?? new Date();
  const expired = expiredRetryEntries(today);
  if (expired.length > 0) {
    const lines = expired.map(
      (entry) => `- \`${entry.file}\` (review by ${entry.reviewBy}, ${entry.trackingIssue})`,
    );
    return finish(options, {
      ok: false,
      summary: [
        '## Contention retry (#1419)',
        '',
        'Retry list expired — renew the review date or remove the entry:',
        '',
        ...lines,
        '',
      ].join('\n'),
      plan: undefined,
      outcome: null,
    });
  }

  const first = await options.runAll();
  if (first.ok) {
    return finish(options, { ok: true, summary: '', plan: undefined, outcome: null });
  }

  const plan = planContentionRetry(first.failures, first.blockers ?? []);
  if (!plan.retry) {
    return finish(options, {
      ok: false,
      summary: formatRetrySummary({ plan }),
      plan,
      outcome: null,
    });
  }

  const retried = await options.runFiles(plan.files);
  const outcome: RetryOutcome = retried.ok ? 'passed' : 'failed';
  return finish(options, {
    ok: retried.ok,
    summary: formatRetrySummary({ plan, outcome }),
    plan,
    outcome,
  });
}

function finish(
  options: ContentionRetryOptions,
  state: {
    ok: boolean;
    summary: string;
    plan: RetryPlan | undefined;
    outcome: RetryOutcome | null;
  },
): ContentionRetryResult {
  const plan = state.plan;
  // Keyed by file, matching what actually reran.
  const retried = plan?.retry
    ? plan.files.map((file) => ({
        file,
        testNames: plan.failures
          .filter((failure) => normalizeTestFile(failure.file) === file)
          .map((failure) => failure.testName),
        trackingIssue:
          CONTENTION_RETRY_FILES.find((entry) => entry.file === file)?.trackingIssue ?? '',
      }))
    : [];
  return {
    ok: state.ok,
    summary: state.summary,
    envelope: laneEnvelope<ContentionRetryTelemetry>({
      lane: LANE_ID,
      commit: options.commit,
      tool: { vitest: options.vitestVersion },
      configHash: options.configHash,
      startedAtMs: options.startedAtMs,
      now: options.now?.(),
      // The retry set is enumerated, not randomized.
      seed: null,
      result: state.ok ? 'pass' : 'fail',
      data: {
        retried,
        retryCount: retried.length,
        retryOutcome: state.outcome,
        listSize: CONTENTION_RETRY_FILES.length,
      },
    }),
  };
}
