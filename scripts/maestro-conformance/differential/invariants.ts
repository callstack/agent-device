// Engine-side invariants over agent-device's own replay timing trace.
//
// Cross-engine outcome parity (exit codes) only catches a flow that outright
// fails. It cannot see a settle-ordering regression that still passes — which
// matters because layer 3 is the ONLY home for bug class 4 (the 200ms x 10 settle
// loop has no reflectable upstream constant to cross-check in layer 2).
//
// These invariants read the `replay-timing.ndjson` written by the test runtime
// (src/daemon/handlers/session-test-runtime.ts) and assert engine-side facts —
// e.g. a tap must not burn the entire settle budget, which is the signature of a
// stability loop that never latches (a full-budget tap measures ~2093-2117ms
// against a 2000ms budget; a healthy Android tap is ~350ms, iOS ~800-1100ms).
//
// The evaluator is pure and unit-tested against synthetic traces; the device run
// that produces a real trace happens only on the scheduled workflow.
import fs from 'node:fs';

export type TraceEvent = {
  type: string;
  step?: number;
  command?: string;
  ok?: boolean;
  durationMs?: number;
  /** Per-step MaestroRuntimeMetrics delta (hierarchyCaptures/screenshotCaptures/tapRetries). */
  resultTiming?: Record<string, unknown>;
};

export type Invariant =
  | {
      kind: 'stepDurationBelow';
      /** Maestro command name the step must match (e.g. "tapOn"). */
      command: string;
      maxMs: number;
      /** Why this bound means the engine behaved correctly. */
      because: string;
    }
  | {
      kind: 'metricAtLeast';
      command: string;
      /** MaestroRuntimeMetrics key, recorded per step as a delta. */
      metric: 'tapRetries' | 'hierarchyCaptures' | 'screenshotCaptures';
      min: number;
      because: string;
    };

export type InvariantResult = {
  invariant: Invariant;
  status: 'held' | 'violated' | 'no-data';
  detail: string;
};

/** Parse an ndjson trace, ignoring blank lines and unparseable records. */
export function readTrace(file: string): TraceEvent[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TraceEvent];
      } catch {
        return [];
      }
    });
}

function completedSteps(events: TraceEvent[], command: string): TraceEvent[] {
  return events.filter((event) => event.type === 'replay_action_stop' && event.command === command);
}

export function evaluateInvariant(events: TraceEvent[], invariant: Invariant): InvariantResult {
  const steps = completedSteps(events, invariant.command);
  if (steps.length === 0) {
    return {
      invariant,
      status: 'no-data',
      detail: `no completed ${invariant.command} steps in the trace`,
    };
  }

  if (invariant.kind === 'metricAtLeast') {
    const values = steps
      .map((step) => step.resultTiming?.[invariant.metric])
      .filter((value): value is number => typeof value === 'number');
    if (values.length === 0) {
      return {
        invariant,
        status: 'no-data',
        detail: `no ${invariant.command} step recorded a ${invariant.metric} metric`,
      };
    }
    // Per-step deltas: the strongest single step is what proves the path ran.
    const best = Math.max(...values);
    if (best < invariant.min) {
      return {
        invariant,
        status: 'violated',
        detail: `highest ${invariant.command} ${invariant.metric} was ${best} (< ${invariant.min}): ${invariant.because}`,
      };
    }
    return {
      invariant,
      status: 'held',
      detail: `${invariant.command} ${invariant.metric} reached ${best} (>= ${invariant.min})`,
    };
  }

  const timed = steps.filter((step) => typeof step.durationMs === 'number');
  if (timed.length === 0) {
    return {
      invariant,
      status: 'no-data',
      detail: `no ${invariant.command} step recorded a duration`,
    };
  }
  const worst = Math.max(...timed.map((step) => step.durationMs ?? 0));
  if (worst >= invariant.maxMs) {
    return {
      invariant,
      status: 'violated',
      detail: `slowest ${invariant.command} took ${worst}ms (>= ${invariant.maxMs}ms): ${invariant.because}`,
    };
  }
  return {
    invariant,
    status: 'held',
    detail: `slowest ${invariant.command} took ${worst}ms (< ${invariant.maxMs}ms)`,
  };
}

export function evaluateInvariants(
  events: TraceEvent[],
  invariants: readonly Invariant[],
): InvariantResult[] {
  return invariants.map((invariant) => evaluateInvariant(events, invariant));
}
