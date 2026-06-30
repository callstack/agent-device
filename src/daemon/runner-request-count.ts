/**
 * Hardware-free counter for "iOS runner requests" in the daemon `--debug`
 * diagnostics ndjson stream.
 *
 * The daemon emits one diagnostic event per real iOS-runner round-trip
 * (`emitDiagnostic` in `../utils/diagnostics.ts`). When a request is in debug
 * mode those events are streamed as one JSON object per line into the daemon
 * log (`<state-dir>/daemon.log`). This module parses that stream and counts the
 * round-trip phases, so the runner request count can be asserted in CI without
 * re-implementing the hand-counting an operator used to do by reading the
 * ndjson by eye.
 *
 * `RUNNER_ROUND_TRIP_PHASES` is the single source of truth shared by the
 * in-process cost graft (`request-router.ts` `buildResponseCost`) and this
 * external ndjson counter, so the two can never drift on which phases count.
 */

// Diagnostic phases emitted once per real iOS-runner round-trip. `..._command_send`
// is the command itself; `..._readiness_preflight` is the pre-command uptime probe
// (a real network round-trip). The `..._skipped` / `..._recovered` markers do NOT
// hit the runner and are intentionally excluded.
export const RUNNER_ROUND_TRIP_PHASES = [
  'ios_runner_command_send',
  'ios_runner_readiness_preflight',
] as const;

export type RunnerRoundTripPhase = (typeof RUNNER_ROUND_TRIP_PHASES)[number];

/**
 * A single parsed line of the daemon `--debug` diagnostics ndjson stream. Only
 * the fields the counter and its drift reporting need are retained; the full
 * record carries more (ts/level/requestId/session/durationMs).
 */
export type ParsedDiagnosticEvent = {
  phase: string;
  command?: string;
};

export type RunnerRequestCounts = {
  runnerRoundTrips: number;
  byPhase: Record<RunnerRoundTripPhase, number>;
};

// The stderr fallback path in `emitDiagnostic` prefixes each ndjson line with
// this tag. The daemon-log path does not, but we tolerate both so the counter
// works against captured stderr too.
const STDERR_DIAGNOSTIC_PREFIX = '[agent-device][diag] ';

/**
 * Tolerant ndjson parser: the daemon log interleaves plain log text with the
 * diagnostic ndjson lines, so non-JSON lines, blank lines, malformed JSON, and
 * objects without a `phase` are skipped rather than throwing.
 */
export function parseDiagnosticNdjson(text: string): ParsedDiagnosticEvent[] {
  const events: ParsedDiagnosticEvent[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith(STDERR_DIAGNOSTIC_PREFIX)) {
      line = line.slice(STDERR_DIAGNOSTIC_PREFIX.length).trim();
    }
    // Fast-skip plain daemon log lines that are not JSON objects.
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = toDiagnosticEvent(parsed);
    if (event) events.push(event);
  }
  return events;
}

function toDiagnosticEvent(value: unknown): ParsedDiagnosticEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const phase = record.phase;
  if (typeof phase !== 'string') return null;
  const command = record.command;
  return typeof command === 'string' ? { phase, command } : { phase };
}

export function emptyRunnerRequestCounts(): RunnerRequestCounts {
  return {
    runnerRoundTrips: 0,
    byPhase: { ios_runner_command_send: 0, ios_runner_readiness_preflight: 0 },
  };
}

/**
 * Count iOS-runner round-trips the way the daemon itself does: tally events
 * whose phase is one of `RUNNER_ROUND_TRIP_PHASES`. Accepts raw ndjson text or
 * already-parsed events.
 */
export function countRunnerRequests(
  input: string | readonly ParsedDiagnosticEvent[],
): RunnerRequestCounts {
  const events = typeof input === 'string' ? parseDiagnosticNdjson(input) : input;
  const counts = emptyRunnerRequestCounts();
  for (const event of events) {
    if (isRunnerRoundTripPhase(event.phase)) {
      counts.byPhase[event.phase] += 1;
      counts.runnerRoundTrips += 1;
    }
  }
  return counts;
}

function isRunnerRoundTripPhase(phase: string): phase is RunnerRoundTripPhase {
  return (RUNNER_ROUND_TRIP_PHASES as readonly string[]).includes(phase);
}

// ---------------------------------------------------------------------------
// Committed baseline + assertion logic (pure, so the CI harness only does I/O)
// ---------------------------------------------------------------------------

/**
 * The committed expected-count baseline. `established: false` means the gate has
 * not been armed yet (no real simulator run has recorded the counts), so the
 * harness records the observed counts instead of asserting.
 */
export type RunnerRequestCountBaseline = RunnerRequestCounts & {
  scenario: string;
  established: boolean;
};

export type RunnerCountDifference = {
  key: 'runnerRoundTrips' | RunnerRoundTripPhase;
  expected: number;
  actual: number;
};

export type RunnerCountComparison =
  | { status: 'unarmed' }
  | { status: 'match' }
  | { status: 'mismatch'; differences: RunnerCountDifference[] };

export function buildRunnerRequestCountBaseline(
  scenario: string,
  counts: RunnerRequestCounts,
): RunnerRequestCountBaseline {
  return {
    scenario,
    established: true,
    runnerRoundTrips: counts.runnerRoundTrips,
    byPhase: { ...counts.byPhase },
  };
}

/**
 * Validate an untrusted baseline payload (read from disk) into a typed baseline.
 * Unknown keys (e.g. a documentation `$comment`) are ignored.
 */
export function parseRunnerRequestCountBaseline(value: unknown): RunnerRequestCountBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Runner request-count baseline must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  const scenario = record.scenario;
  if (typeof scenario !== 'string' || scenario.length === 0) {
    throw new Error('Runner request-count baseline is missing a "scenario" string.');
  }
  const byPhaseRaw = record.byPhase;
  if (!byPhaseRaw || typeof byPhaseRaw !== 'object' || Array.isArray(byPhaseRaw)) {
    throw new Error('Runner request-count baseline is missing a "byPhase" object.');
  }
  const byPhaseRecord = byPhaseRaw as Record<string, unknown>;
  const byPhase = emptyRunnerRequestCounts().byPhase;
  for (const phase of RUNNER_ROUND_TRIP_PHASES) {
    byPhase[phase] = asCount(byPhaseRecord[phase], `byPhase.${phase}`);
  }
  return {
    scenario,
    established: record.established === true,
    runnerRoundTrips: asCount(record.runnerRoundTrips, 'runnerRoundTrips'),
    byPhase,
  };
}

function asCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `Runner request-count baseline field "${field}" must be a non-negative integer.`,
    );
  }
  return value;
}

/**
 * Compare observed counts against the committed baseline. Returns `unarmed`
 * when the baseline has not been established yet (the caller should record, not
 * fail), `match` when every count is identical, or `mismatch` with the exact
 * per-key differences a runner refactor introduced.
 */
export function compareRunnerCounts(
  baseline: RunnerRequestCountBaseline,
  observed: RunnerRequestCounts,
): RunnerCountComparison {
  if (!baseline.established) return { status: 'unarmed' };
  const differences: RunnerCountDifference[] = [];
  if (baseline.runnerRoundTrips !== observed.runnerRoundTrips) {
    differences.push({
      key: 'runnerRoundTrips',
      expected: baseline.runnerRoundTrips,
      actual: observed.runnerRoundTrips,
    });
  }
  for (const phase of RUNNER_ROUND_TRIP_PHASES) {
    if (baseline.byPhase[phase] !== observed.byPhase[phase]) {
      differences.push({
        key: phase,
        expected: baseline.byPhase[phase],
        actual: observed.byPhase[phase],
      });
    }
  }
  return differences.length === 0 ? { status: 'match' } : { status: 'mismatch', differences };
}
