import type { SessionAction } from '@agent-device/contracts/session';
import type { SnapshotTimingSample } from '@agent-device/contracts/capture';

/**
 * #1478 P5 stage C2b: the `.ad` step-loop ENGINE policy, split out of
 * `session-replay-runtime.ts`'s `executeReplayActions` /
 * `resolveReplayStepResponse` / `buildReplayActionFailure`. Everything that
 * touches a real device, a snapshot, `SessionStore`, or the P4b repair
 * coordinator is daemon authority and stays behind the narrow
 * `AdReplayStepRuntime` capabilities below — this module only decides which
 * action to run next, when to skip one, and when to stop.
 *
 * #1555 review P1 ("do not smuggle daemon wire failures through a generic"):
 * `AdReplayStepRuntime` no longer carries a `TResponse` type parameter. The
 * loop never sees a `DaemonResponse`/wire object at all, not even opaquely —
 * `executeStep`/`handleActionFailure` return the NEUTRAL tagged types below
 * (`AdReplayStepOutcome`, `AdReplayStepFailure`), built only from plain
 * values (a `kind` string, a `message` string, artifact paths). The daemon
 * adapter (`createAdReplayStepRuntime`, `session-replay-runtime.ts`) is the
 * only place a real `DaemonResponse` is constructed or read; it keeps its
 * OWN wire response in a local variable ("the side-map") as it builds each
 * neutral outcome, and `runReplayScriptFile` reads that variable back after
 * `runAdReplay` reports which step failed, so the final response returned to
 * the client is byte-identical to before this split — it was never
 * round-tripped through the engine's return value at all.
 */

/** Neutral per-step failure: no `DaemonResponse`, no wire shape — just what the engine needs to report. */
export type AdReplayStepFailure = Readonly<{
  /** The daemon's own error/divergence discriminant (e.g. a `DaemonError.code`), carried opaquely. */
  readonly kind: string;
  readonly message: string;
  readonly artifactPaths: readonly string[];
}>;

/** `executeStep`'s per-dispatch result: pass, or a neutral failure (never a wire response). */
export type AdReplayStepOutcome =
  | Readonly<{ readonly status: 'ok'; readonly artifactPaths: readonly string[] }>
  | Readonly<{ readonly status: 'failed'; readonly failure: AdReplayStepFailure }>;

/**
 * A single progress step, structurally mirroring
 * `@agent-device/replay-test`'s `ReplayTestAttemptStep` — deliberately not
 * imported from that package (engine-to-engine imports are 0 by design). The
 * daemon adapter's sink is structurally compatible, so no translation layer
 * is needed at the call site.
 */
export type AdReplayProgressStep = Readonly<{
  readonly index: number;
  readonly total: number;
  readonly command?: string;
  readonly value?: string;
}>;

export type AdReplayProgressSink = (step: AdReplayProgressStep) => void;

/**
 * The injected capability bag `runAdReplay` threads the step loop through —
 * narrow execute/capture/observe/stamp daemon capabilities, modeled on what
 * the loop actually consumes (`MaestroRuntimeOperations`,
 * `packages/maestro/src/internal/runtime-port-types.ts`, is the precedent).
 * Never `DaemonRequest`, `DaemonError`, `SessionStore`, or a reporter/event
 * stream — and, as of the #1555 review pass, never a `DaemonResponse`
 * either.
 */
export type AdReplayStepRuntime = Readonly<{
  /**
   * Verifies the recorded target (if any) then dispatches the action.
   * Capture, the single `invoke` dispatch site, and the post-resolution
   * guard/landmark-mismatch conversion are all daemon authority; only the
   * neutral pass/fail projection crosses back into the engine.
   */
  executeStep(
    action: SessionAction,
    index: number,
    artifactPaths: readonly string[],
  ): Promise<AdReplayStepOutcome>;
  /**
   * Wraps a failed step with replay failure diagnostics and repair-held
   * marking — daemon authority (capture, `SessionStore`, the P4b
   * coordinator) — and returns the neutral failure the run outcome reports.
   */
  handleActionFailure(params: {
    action: SessionAction;
    index: number;
    artifactPaths: readonly string[];
    snapshotDiagnosticSamples: readonly SnapshotTimingSample[];
  }): Promise<AdReplayStepFailure>;
  /** Arms the save-script transaction for this step; a no-op absent `--save-script`. Repair authority. */
  armStep(): void;
  /** Whether the request's session currently carries an armed repair boundary. Repair authority. */
  isRepairArmed(): boolean;
  /** The recorded selector's display value for progress reporting — needs the private selector AST, daemon-only. */
  describeStepValue(action: SessionAction): string | undefined;
  /** Optional per-attempt progress sink. */
  onStep?: AdReplayProgressSink;
  /** The current snapshot-diagnostics sample count, as a resumable marker. */
  diagnosticsMarker(): number;
  /** Snapshot-diagnostics samples recorded since `marker`. */
  diagnosticsSince(marker: number): SnapshotTimingSample[];
}>;

export type AdReplayRunRequest = Readonly<{
  readonly actions: readonly SessionAction[];
  /** 0-based loop entry index — already resolved from `--from`/`--plan-digest` daemon-side. */
  readonly entryIndex: number;
}>;

/** Neutral run-level outcome: `runAdReplay` never returns or holds a `DaemonResponse`. */
export type AdReplayRunOutcome =
  | Readonly<{
      readonly status: 'completed';
      readonly replayed: number;
      readonly artifactPaths: readonly string[];
      readonly snapshotDiagnosticSamples: readonly SnapshotTimingSample[];
    }>
  | Readonly<{
      readonly status: 'failed';
      readonly stepIndex: number;
      readonly failure: AdReplayStepFailure;
    }>;

/**
 * ADR 0012 step 4's step loop: for every executable action from
 * `request.entryIndex` on, arm the save-script transaction, skip a
 * repair-armed plan's terminal `close` (lifecycle, not a script step), report
 * progress, dispatch through `runtime.executeStep`, and stop at the first
 * failure. Moved verbatim from `executeReplayActions`'s composition order —
 * only the daemon capabilities it calls through were narrowed into
 * `runtime`.
 */
export async function runAdReplay(
  request: AdReplayRunRequest,
  runtime: AdReplayStepRuntime,
): Promise<AdReplayRunOutcome> {
  const { actions, entryIndex } = request;
  const artifactPaths = new Set<string>();
  const snapshotDiagnosticSamples: SnapshotTimingSample[] = [];
  for (let index = entryIndex; index < actions.length; index += 1) {
    const action = actions[index];
    if (!isExecutableReplayAction(action)) continue;
    // Arm before checking terminal close so `[open, close]` records the
    // session created by `open` before treating `close` as lifecycle.
    runtime.armStep();
    if (isRepairArmedTerminalCloseAction(action, index, actions.length, runtime.isRepairArmed())) {
      continue;
    }
    // `onStep?.(x)` short-circuits evaluating `x` when `onStep` is absent
    // (the ordinary `replay` command has no sink) — an explicit guard
    // preserves that: `describeStepValue` must not run needlessly.
    if (runtime.onStep) {
      const value = runtime.describeStepValue(action);
      runtime.onStep(buildAdReplayProgressStep(index, actions.length, action, value));
    }
    const sampleStart = runtime.diagnosticsMarker();
    const stepOutcome = await runtime.executeStep(action, index, [...artifactPaths]);
    snapshotDiagnosticSamples.push(...runtime.diagnosticsSince(sampleStart));
    if (stepOutcome.status === 'ok') {
      stepOutcome.artifactPaths.forEach((entry) => artifactPaths.add(entry));
      continue;
    }
    stepOutcome.failure.artifactPaths.forEach((entry) => artifactPaths.add(entry));
    const failure = await runtime.handleActionFailure({
      action,
      index,
      artifactPaths: [...artifactPaths],
      snapshotDiagnosticSamples,
    });
    return { status: 'failed', stepIndex: index, failure };
  }
  return {
    status: 'completed',
    replayed: actions.length - entryIndex,
    artifactPaths: [...artifactPaths],
    snapshotDiagnosticSamples,
  };
}

/**
 * ADR 0012 decision 6 (Fix 3): a nested `replay` line in an `.ad` file is
 * lifecycle-skipped, never dispatched or expanded (native `.ad` has no
 * include grammar).
 */
export function isExecutableReplayAction(
  action: SessionAction | undefined,
): action is SessionAction {
  return Boolean(action && action.command !== 'replay');
}

/**
 * ADR 0012 decision 6 (Fix 3): the source plan's own terminal `close` is
 * lifecycle, not a script step to replay, while a repair is armed — the agent
 * finalizes the transaction with `close --save-script` instead. Replaying the
 * recorded `close` here would dispatch it as an ordinary step: it tears the
 * session down (and, absent Fix 1/2, could even publish or diverge) before
 * the agent gets that chance. Skipped exactly like the `replay` pseudo-command
 * just above it in the loop — never dispatched, never divergence-checked,
 * and (like that skip) not counted out of `replayed`. `repairArmed` reflects
 * session state, not this invocation's own flags, matching R2: a repair stays
 * armed across separate `--from` legs regardless of whether `--save-script`
 * is repeated on each one.
 */
export function isRepairArmedTerminalCloseAction(
  action: SessionAction,
  index: number,
  totalActions: number,
  repairArmed: boolean,
): boolean {
  if (action.command !== 'close') return false;
  if (index !== totalActions - 1) return false;
  return repairArmed;
}

function buildAdReplayProgressStep(
  actionIndex: number,
  actionTotal: number,
  action: SessionAction,
  value: string | undefined,
): AdReplayProgressStep {
  return {
    index: actionIndex + 1,
    total: actionTotal,
    command: action.command,
    ...(value !== undefined ? { value } : {}),
  };
}

export function formatReplaySuccessMessage(replayed: number, wallClockMs: number): string {
  const seconds = (wallClockMs / 1000).toFixed(1);
  const noun = replayed === 1 ? 'step' : 'steps';
  return `Replayed ${replayed} ${noun} in ${seconds}s`;
}
