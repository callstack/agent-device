import type { AgentDeviceClient, CommandRequestResult } from '../../src/client/client-types.ts';
import { AppError, normalizeError, type NormalizedError } from '../../src/kernel/errors.ts';
import { snapshotCliOutput } from '../../src/commands/capture/output.ts';
import { interactionCliOutputFormatters } from '../../src/commands/interaction/output.ts';
import { createCommandToolExecutor } from '../../src/mcp/command-tools.ts';
import { REF_TOKEN_PATTERN, type EconomySample } from './economy-metrics.ts';
import { SETTLE_ADDED_REF_RESULT, SNAPSHOT_DAEMON_RESULT, SNAPSHOT_RESULT } from './fixtures.ts';

// A routine workflow-level oracle (#1180). PR #1174 pinned per-surface output
// budgets; this pairs those bytes with the follow-up behavior they enable, so a
// smaller response that forces an extra observation, an extra retry, or a lost
// recovery handle is measured as more expensive, not less.
//
// The steps below chain into ONE coherent session (orient -> mutate -> read ->
// recover) built on the shared per-surface fixtures in `./fixtures.ts`, so the
// two suites cannot drift and the derived counts come from the real formatters,
// not hand-declared numbers: dropping the settled diff's added refs, the
// unchanged-interactive tail, or the failure's recovery details changes the
// measured counts and fails the regression tests. Only the workflow-specific
// adaptations (an unchanged recheck, the tail retargeted onto a surfaced ref,
// the in-session timeout failure, and its recovered retry) are declared here.

// Matches the shared snapshot fixture's session/generation so refs stay valid
// across the whole chain (SNAPSHOT_RESULT.identifiers.session, and
// SETTLE_TAIL_RESULT mints refsGeneration 14 — the last generation).
const WORKFLOW_SESSION = 'economy-fixture';
const REFS_GENERATION = 14;

// snapshot -i again with nothing changed: the suppression notice instead of a
// re-emitted tree (the cheapest re-orientation), reaffirming the prior @e refs.
const RECHECK_RESULT = {
  ...SNAPSHOT_RESULT,
  unchanged: { ageMs: 480, nodeCount: SNAPSHOT_RESULT.nodes.length, interactiveOnly: true },
};

// press @e5 (View receipt, surfaced by the settled diff) --settle: a
// removals-only diff would hide the settled tree's remaining actionable
// elements, so the unchanged-interactive tail carries the next target (@e7)
// without a fresh snapshot. The shared SETTLE_TAIL_RESULT taps an @e6 nothing
// upstream surfaced, so it cannot join this chain; this reuses its tail shape
// (e7 Continue, e9 Home) on a ref the settled diff already handed out.
const WORKFLOW_TAIL_RESULT: CommandRequestResult = {
  ref: 'e5',
  x: 320,
  y: 300,
  message: 'Tapped @e5 (320, 300)',
  settle: {
    settled: true,
    waitedMs: 410,
    captures: 2,
    quietMs: 250,
    timeoutMs: 3000,
    refsGeneration: REFS_GENERATION,
    diff: {
      summary: { additions: 0, removals: 1, unchanged: 6 },
      lines: [{ kind: 'removed', text: '@e5 [button] "View receipt"' }],
    },
    tail: [
      { ref: 'e7', role: 'button', label: 'Continue' },
      { ref: 'e9', role: 'tab', label: 'Home' },
    ],
  },
};

// get text @e4: answers the verification question from an already-surfaced ref,
// no extra observation.
const READ_RESULT: CommandRequestResult = { ref: '@e4', text: 'Order confirmed' };

// press @e7 (Continue, from the tail) --settle times out. The actionable failure
// keeps stable identity (code + reason + the failing ref), the session it
// happened in, the snapshot generation those refs belong to, an explicit retry
// signal, and next-step guidance — everything the agent needs to retry IN THE
// SAME SESSION without reopening or re-observing. Recovery keys on structured
// details, never message text. (The shared ACTIONABLE_ERROR is a DEVICE_IN_USE
// lock held by a *different* session, so it models cross-session recovery, not
// in-session timeout recovery, and is intentionally not reused here.)
const FAILURE_ERROR = new AppError('COMMAND_FAILED', 'Tap on @e7 did not settle within 10000ms', {
  reason: 'timeout',
  timeoutMs: 10_000,
  ref: '@e7',
  session: WORKFLOW_SESSION,
  refsGeneration: REFS_GENERATION,
  retriable: true,
  hint: 'The tap did not settle in time. Retry press @e7 --settle with a higher --timeout; refs from this session are still valid.',
});

// The recovered retry of the SAME target succeeds; no fresh observation was
// needed because the failure preserved the session and its ref generation.
const RETRY_RESULT: CommandRequestResult = {
  ref: 'e7',
  x: 320,
  y: 60,
  message: 'Tapped @e7 (320, 60)',
  settle: {
    settled: true,
    waitedMs: 320,
    captures: 2,
    quietMs: 250,
    timeoutMs: 15_000,
    refsGeneration: REFS_GENERATION,
    diff: {
      summary: { additions: 0, removals: 1, unchanged: 6 },
      lines: [{ kind: 'removed', text: '@e7 [button] "Continue"' }],
    },
  },
};

// 'cli'/'mcp' are rendered per-projection; 'shared' is the projection-invariant
// structured payload both surfaces carry (the normalized error's recovery
// fields are identical in the CLI --json body and the MCP structuredContent).
export type WorkflowProjection = 'cli' | 'mcp' | 'shared';

export type WorkflowStepKind = 'orient' | 'recheck' | 'mutation' | 'read' | 'failure' | 'retry';

export type WorkflowStep = {
  id: string;
  command: string;
  kind: WorkflowStepKind;
  /**
   * The @ref this command targets. An earlier step's response must have
   * surfaced it; otherwise the step would force a fallback observation.
   */
  targetRef?: string;
  /** Projections rendered for this command, keyed by projection. */
  samples: Partial<Record<WorkflowProjection, EconomySample>>;
};

export type RecoveryFields = {
  code: string | undefined;
  session: string | undefined;
  refsGeneration: number | undefined;
  retriable: boolean | undefined;
  hint: string | undefined;
};

export type WorkflowStepMetric = {
  id: string;
  command: string;
  kind: WorkflowStepKind;
  bytes: number;
  targetRef?: string;
  targetSurfacedBy?: string;
};

export type RoutineWorkflowMeasurement = {
  totalBytes: number;
  commandCount: number;
  fallbackObservationCount: number;
  retryCount: number;
  recoveryPreservesSession: boolean;
  recoveryFields: RecoveryFields;
  steps: WorkflowStepMetric[];
};

function readCliText(output: { text?: string | null }): string {
  return output.text ?? '';
}

function interactionText(result: CommandRequestResult): string {
  return readCliText(interactionCliOutputFormatters.press({ input: {}, result }));
}

async function renderMcpSnapshot(): Promise<unknown> {
  return await createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => SNAPSHOT_DAEMON_RESULT,
  }).execute('snapshot', {});
}

export async function renderRoutineWorkflow(): Promise<{
  steps: WorkflowStep[];
  error: NormalizedError;
  measurement: RoutineWorkflowMeasurement;
  samples: Record<string, EconomySample>;
}> {
  const error = normalizeError(FAILURE_ERROR);
  const orientText = readCliText(
    snapshotCliOutput({ result: SNAPSHOT_RESULT, interactiveOnly: true }),
  );
  const recheckText = readCliText(
    snapshotCliOutput({ result: RECHECK_RESULT, interactiveOnly: true }),
  );
  const mcpSnapshot = await renderMcpSnapshot();

  const steps: WorkflowStep[] = [
    {
      id: 'orient',
      command: 'snapshot -i',
      kind: 'orient',
      samples: { cli: { text: orientText }, mcp: { data: mcpSnapshot } },
    },
    {
      id: 'recheck',
      command: 'snapshot -i',
      kind: 'recheck',
      samples: { cli: { text: recheckText } },
    },
    {
      id: 'mutation-confirm',
      command: 'press @e3 --settle',
      kind: 'mutation',
      targetRef: '@e3',
      // Only the rendered CLI settled-diff carries e5. If that formatter stops
      // emitting added refs, `mutation-tail` loses its target and the
      // fallback-observation count rises — so this step is a genuine formatter
      // guard, not a scan of the raw fixture object.
      samples: { cli: { text: interactionText(SETTLE_ADDED_REF_RESULT) } },
    },
    {
      id: 'mutation-tail',
      command: 'press @e5 --settle',
      kind: 'mutation',
      targetRef: '@e5',
      samples: { cli: { text: interactionText(WORKFLOW_TAIL_RESULT) } },
    },
    {
      id: 'read',
      command: 'get text @e4',
      kind: 'read',
      targetRef: '@e4',
      samples: {
        cli: {
          text: readCliText(
            interactionCliOutputFormatters.get({ input: { format: 'text' }, result: READ_RESULT }),
          ),
        },
      },
    },
    {
      id: 'failure',
      command: 'press @e7 --settle',
      kind: 'failure',
      targetRef: '@e7',
      samples: { shared: { data: error } },
    },
    {
      id: 'retry',
      command: 'press @e7 --settle --timeout 15000',
      kind: 'retry',
      targetRef: '@e7',
      samples: { cli: { text: interactionText(RETRY_RESULT) } },
    },
  ];

  const measurement = measureRoutineWorkflow(steps, error);
  return { steps, error, measurement, samples: workflowSamples(steps) };
}

function workflowSamples(steps: WorkflowStep[]): Record<string, EconomySample> {
  const entries: [string, EconomySample][] = [];
  for (const step of steps) {
    for (const [projection, sample] of Object.entries(step.samples)) {
      const shape = 'text' in sample ? 'text' : 'json';
      entries.push([`workflow.${step.id}.${projection}.${shape}`, sample]);
    }
  }
  return Object.fromEntries(entries);
}

function refsInSample(sample: EconomySample): string[] {
  const serialized = 'text' in sample ? sample.text : JSON.stringify(sample.data);
  return serialized.match(REF_TOKEN_PATTERN) ?? [];
}

function measureRoutineWorkflow(
  steps: WorkflowStep[],
  error: NormalizedError,
): RoutineWorkflowMeasurement {
  const surfacedBy = new Map<string, string>();
  // Sequential so each step sees only the refs earlier steps surfaced.
  const stepMetrics = steps.map((step) => evaluateStep(step, surfacedBy));
  const recoveryFields = readRecoveryFields(error);
  return {
    totalBytes: stepMetrics.reduce((sum, metric) => sum + metric.bytes, 0),
    commandCount: steps.length,
    fallbackObservationCount: stepMetrics.filter(forcesFallbackObservation).length,
    retryCount: stepMetrics.filter((metric) => metric.kind === 'retry').length,
    recoveryPreservesSession: preservesSession(recoveryFields),
    recoveryFields,
    steps: stepMetrics,
  };
}

function evaluateStep(step: WorkflowStep, surfacedBy: Map<string, string>): WorkflowStepMetric {
  // Read the target against earlier refs BEFORE recording this step's own refs,
  // so a step never counts as surfacing the target it consumes.
  const targetSurfacedBy = step.targetRef ? surfacedBy.get(step.targetRef) : undefined;
  recordSurfacedRefs(step, surfacedBy);
  return {
    id: step.id,
    command: step.command,
    kind: step.kind,
    bytes: sumSampleBytes(step.samples),
    targetRef: step.targetRef,
    targetSurfacedBy,
  };
}

// A target that no earlier response surfaced would force the agent to insert an
// observation (snapshot/find/get) purely to recover it.
function forcesFallbackObservation(metric: WorkflowStepMetric): boolean {
  return metric.targetRef !== undefined && metric.targetSurfacedBy === undefined;
}

function recordSurfacedRefs(step: WorkflowStep, surfacedBy: Map<string, string>): void {
  for (const sample of Object.values(step.samples)) {
    for (const ref of refsInSample(sample)) {
      if (!surfacedBy.has(ref)) surfacedBy.set(ref, step.id);
    }
  }
}

function sumSampleBytes(samples: WorkflowStep['samples']): number {
  return Object.values(samples).reduce((sum, sample) => sum + sampleBytes(sample), 0);
}

function sampleBytes(sample: EconomySample): number {
  const serialized = 'text' in sample ? sample.text : JSON.stringify(sample.data);
  return Buffer.byteLength(serialized);
}

function readRecoveryFields(error: NormalizedError): RecoveryFields {
  const details = error.details ?? {};
  return {
    code: error.code,
    session: typeof details.session === 'string' ? details.session : undefined,
    refsGeneration: typeof details.refsGeneration === 'number' ? details.refsGeneration : undefined,
    retriable: error.retriable,
    hint: error.hint,
  };
}

function preservesSession(fields: RecoveryFields): boolean {
  return (
    fields.code !== undefined &&
    fields.session !== undefined &&
    fields.refsGeneration !== undefined &&
    fields.retriable === true &&
    fields.hint !== undefined
  );
}
