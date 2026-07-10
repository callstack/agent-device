import type {
  AgentDeviceClient,
  CaptureSnapshotResult,
  CommandRequestResult,
} from '../../src/client/client-types.ts';
import type { DaemonResponseData } from '../../src/daemon/types.ts';
import { AppError, normalizeError, type NormalizedError } from '../../src/kernel/errors.ts';
import { attachRefs, type RawSnapshotNode } from '../../src/kernel/snapshot.ts';
import { snapshotCliOutput } from '../../src/commands/capture/output.ts';
import { interactionCliOutputFormatters } from '../../src/commands/interaction/output.ts';
import { createCommandToolExecutor } from '../../src/mcp/command-tools.ts';
import type { EconomySample } from './economy-metrics.ts';

// A routine workflow-level oracle (#1180). PR #1174 pinned per-surface output
// budgets; this pairs those bytes with the follow-up behavior they enable, so a
// smaller response that forces an extra observation, an extra retry, or a lost
// recovery handle is measured as more expensive, not less.
//
// The fixtures below form ONE coherent checkout session whose refs chain across
// steps (orient -> mutate -> read -> recover), so the derived counts come from
// the real formatters, not from hand-declared numbers: dropping the settled
// diff's added refs, the unchanged-interactive tail, or the failure's recovery
// details changes the measured counts and fails the regression tests.

const WORKFLOW_SESSION = 'checkout';
const ORIENT_GENERATION = 20;
const SETTLE_CONFIRM_GENERATION = 21;
const SETTLE_TAIL_GENERATION = 22;

const ORIENT_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    type: 'Window',
    label: 'Checkout',
    depth: 0,
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  {
    index: 1,
    type: 'TextField',
    role: 'text-field',
    label: 'Email',
    value: 'qa@example.com',
    identifier: 'checkout-email',
    hittable: true,
    enabled: true,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 120, width: 350, height: 44 },
  },
  {
    index: 2,
    type: 'Button',
    role: 'button',
    label: 'Place order',
    identifier: 'submit-order',
    hittable: true,
    enabled: true,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 720, width: 350, height: 48 },
  },
];

// attachRefs numbers by position: e1 window, e2 email, e3 Place order.
const ORIENT_RESULT: CaptureSnapshotResult = {
  nodes: attachRefs(ORIENT_NODES),
  truncated: false,
  identifiers: { session: WORKFLOW_SESSION },
  visibility: { partial: false, visibleNodeCount: 3, totalNodeCount: 3, reasons: [] },
};

const ORIENT_DAEMON_RESULT: DaemonResponseData = {
  ...ORIENT_RESULT,
  refsGeneration: ORIENT_GENERATION,
};

// Re-taking snapshot -i with nothing changed collapses to the suppression
// notice instead of re-emitting the tree: the cheapest possible re-orientation,
// and it explicitly reaffirms the previous @e refs stay valid.
const RECHECK_RESULT: CaptureSnapshotResult = {
  ...ORIENT_RESULT,
  unchanged: { ageMs: 480, nodeCount: 3, interactiveOnly: true },
};

// press @e3 (Place order) --settle: the settled diff hands out the refs the
// next two steps target (e4 read target, e5 next mutation target).
const SETTLE_CONFIRM_RESULT: CommandRequestResult = {
  ref: 'e3',
  x: 195,
  y: 744,
  message: 'Tapped @e3 (195, 744)',
  settle: {
    settled: true,
    waitedMs: 540,
    captures: 3,
    quietMs: 250,
    timeoutMs: 3000,
    refsGeneration: SETTLE_CONFIRM_GENERATION,
    diff: {
      summary: { additions: 2, removals: 1, unchanged: 4 },
      lines: [
        { kind: 'removed', text: '@e3 [button] "Place order"' },
        { kind: 'added', text: '@e4 [text] "Order confirmed"', ref: 'e4' },
        { kind: 'added', text: '@e5 [button] "View receipt"', ref: 'e5' },
      ],
    },
  },
};

// press @e5 (View receipt) --settle: a removals-only diff would otherwise hide
// the settled tree's remaining actionable elements, so the unchanged-interactive
// tail carries the next target (e6 Done) without a fresh snapshot.
const SETTLE_TAIL_RESULT: CommandRequestResult = {
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
    refsGeneration: SETTLE_TAIL_GENERATION,
    diff: {
      summary: { additions: 0, removals: 1, unchanged: 6 },
      lines: [{ kind: 'removed', text: '@e5 [button] "View receipt"' }],
    },
    tail: [
      { ref: 'e6', role: 'button', label: 'Done' },
      { ref: 'e7', role: 'tab', label: 'Home' },
    ],
  },
};

// get text @e4: answers the verification question from the already-surfaced ref,
// no extra observation.
const READ_RESULT: CommandRequestResult = {
  ref: '@e4',
  text: 'Order confirmed',
};

// press @e6 (Done) --settle times out. The actionable failure keeps stable
// identity (code + reason + the failing ref), the session it happened in, the
// snapshot generation those refs belong to, an explicit retry signal, and
// next-step guidance — everything the agent needs to retry IN THE SAME SESSION
// without reopening or re-observing. Recovery keys on structured details, never
// on the message text.
const FAILURE_ERROR = new AppError('COMMAND_FAILED', 'Tap on @e6 did not settle within 10000ms', {
  reason: 'timeout',
  timeoutMs: 10_000,
  ref: '@e6',
  session: WORKFLOW_SESSION,
  refsGeneration: SETTLE_TAIL_GENERATION,
  retriable: true,
  hint: 'The tap did not settle in time. Retry press @e6 --settle with a higher --timeout; refs from this session are still valid.',
});

// The recovered retry of the SAME target succeeds; no fresh observation was
// needed because the failure preserved the session and its ref generation.
const RETRY_RESULT: CommandRequestResult = {
  ref: 'e6',
  x: 195,
  y: 640,
  message: 'Tapped @e6 (195, 640)',
  settle: {
    settled: true,
    waitedMs: 320,
    captures: 2,
    quietMs: 250,
    timeoutMs: 15_000,
    refsGeneration: SETTLE_TAIL_GENERATION,
    diff: {
      summary: { additions: 0, removals: 1, unchanged: 6 },
      lines: [{ kind: 'removed', text: '@e6 [button] "Done"' }],
    },
    tail: [{ ref: 'e7', role: 'tab', label: 'Home' }],
  },
};

export type WorkflowProjection = 'cli' | 'mcp';

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
    runCommand: async () => ORIENT_DAEMON_RESULT,
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
    snapshotCliOutput({ result: ORIENT_RESULT, interactiveOnly: true }),
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
      samples: {
        cli: { text: interactionText(SETTLE_CONFIRM_RESULT) },
        mcp: { data: SETTLE_CONFIRM_RESULT },
      },
    },
    {
      id: 'mutation-tail',
      command: 'press @e5 --settle',
      kind: 'mutation',
      targetRef: '@e5',
      samples: { cli: { text: interactionText(SETTLE_TAIL_RESULT) } },
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
      command: 'press @e6 --settle',
      kind: 'failure',
      targetRef: '@e6',
      samples: { cli: { data: error }, mcp: { data: error } },
    },
    {
      id: 'retry',
      command: 'press @e6 --settle --timeout 15000',
      kind: 'retry',
      targetRef: '@e6',
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

const REF_PATTERN = /@?e\d+/g;

function refsInSample(sample: EconomySample): string[] {
  const serialized = 'text' in sample ? sample.text : JSON.stringify(sample.data);
  return (serialized.match(REF_PATTERN) ?? []).map((ref) =>
    ref.startsWith('@') ? ref : `@${ref}`,
  );
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
