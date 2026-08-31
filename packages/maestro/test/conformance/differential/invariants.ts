// Engine-side invariants over agent-device's own replay timing trace.
//
// Cross-engine outcome parity (exit codes) only catches a flow that outright
// fails. It cannot see a settle-ordering regression that still passes — which
// matters because layer 3 is the ONLY home for bug class 4 (the 200ms x 10 settle
// loop has no reflectable upstream constant to cross-check in layer 2).
//
// These invariants read the `replay-timing.ndjson` written by the test runtime
// (src/daemon/handlers/session-test-runtime.ts) and assert engine-side facts —
// e.g. a tap's stability loop must latch rather than run out of settle budget.
//
// The evaluator is pure and unit-tested against synthetic traces; the device run
// that produces a real trace happens only on the scheduled workflow.
import fs from 'node:fs';
import type { MaestroRuntimeMetrics } from '../../../src/internal/engine-types.ts';

export type TraceEvent = {
  type: string;
  step?: number;
  command?: string;
  ok?: boolean;
  durationMs?: number;
  /** Per-step MaestroRuntimeMetrics delta. */
  resultTiming?: Record<string, unknown>;
};

export type MetricKey = keyof MaestroRuntimeMetrics;

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
      metric: MetricKey;
      min: number;
      because: string;
    }
  | {
      kind: 'metricAtMost';
      command: string;
      metric: MetricKey;
      max: number;
      because: string;
    }
  | {
      kind: 'gestureExecutionProfile';
      command: string;
      profile: 'endpoint-hold' | 'timed-pan';
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

type MetricBound = Extract<Invariant, { kind: 'metricAtLeast' | 'metricAtMost' }>;

function metricBoundTerms(invariant: MetricBound) {
  return invariant.kind === 'metricAtMost'
    ? {
        broken: (peak: number) => peak > invariant.max,
        failed: `> ${invariant.max}`,
        held: (peak: number) => `stayed at ${peak} (<= ${invariant.max})`,
      }
    : {
        broken: (peak: number) => peak < invariant.min,
        failed: `< ${invariant.min}`,
        held: (peak: number) => `reached ${peak} (>= ${invariant.min})`,
      };
}

function evaluateMetricBound(steps: TraceEvent[], invariant: MetricBound): InvariantResult {
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
  const peak = Math.max(...values);
  const terms = metricBoundTerms(invariant);
  return terms.broken(peak)
    ? {
        invariant,
        status: 'violated',
        detail: `highest ${invariant.command} ${invariant.metric} was ${peak} (${terms.failed}): ${invariant.because}`,
      }
    : {
        invariant,
        status: 'held',
        detail: `${invariant.command} ${invariant.metric} ${terms.held(peak)}`,
      };
}

function evaluateGestureProfile(
  steps: TraceEvent[],
  invariant: Extract<Invariant, { kind: 'gestureExecutionProfile' }>,
): InvariantResult {
  const profiles = steps
    .map((step) => step.resultTiming?.executionProfile)
    .filter((value): value is string => typeof value === 'string');
  if (profiles.length === 0) {
    return {
      invariant,
      status: 'no-data',
      detail: `no ${invariant.command} step recorded an executionProfile`,
    };
  }
  const firstMismatch = profiles.find((profile) => profile !== invariant.profile);
  if (firstMismatch !== undefined) {
    return {
      invariant,
      status: 'violated',
      detail: `${invariant.command} executionProfile was ${firstMismatch} (expected ${invariant.profile}): ${invariant.because}`,
    };
  }
  return {
    invariant,
    status: 'held',
    detail: `${invariant.command} executionProfile is ${invariant.profile} on ${profiles.length} step(s)`,
  };
}

function evaluateStepDuration(
  steps: TraceEvent[],
  invariant: Extract<Invariant, { kind: 'stepDurationBelow' }>,
): InvariantResult {
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

export function evaluateInvariant(events: TraceEvent[], invariant: Invariant): InvariantResult {
  const steps = completedSteps(events, invariant.command);
  if (steps.length === 0) {
    return {
      invariant,
      status: 'no-data',
      detail: `no completed ${invariant.command} steps in the trace`,
    };
  }
  if (invariant.kind === 'metricAtMost' || invariant.kind === 'metricAtLeast') {
    return evaluateMetricBound(steps, invariant);
  }
  if (invariant.kind === 'gestureExecutionProfile') return evaluateGestureProfile(steps, invariant);
  return evaluateStepDuration(steps, invariant);
}

export function evaluateInvariants(
  events: TraceEvent[],
  invariants: readonly Invariant[],
): InvariantResult[] {
  return invariants.map((invariant) => evaluateInvariant(events, invariant));
}
