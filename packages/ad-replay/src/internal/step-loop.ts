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
 * `TResponse` is the daemon's own response type, injected generically: the
 * loop only ever reads its `ok` discriminant (never `DaemonError`,
 * `SessionStore`, or a wire shape) and returns it unopened — the daemon
 * adapter is the only side that ever constructs or interprets one.
 */

/** The one field the step loop reads off a daemon response: pass/fail. */
export type AdReplayResponse = Readonly<{ readonly ok: boolean }>;

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
 * stream.
 */
export type AdReplayStepRuntime<TResponse extends AdReplayResponse> = Readonly<{
  /**
   * Verifies the recorded target (if any) then dispatches the action.
   * Capture, the single `invoke` dispatch site, and the post-resolution
   * guard/landmark-mismatch conversion are all daemon authority.
   */
  executeStep(
    action: SessionAction,
    index: number,
    artifactPaths: readonly string[],
  ): Promise<TResponse>;
  /**
   * Wraps a failed step's response with replay failure diagnostics and
   * repair-held marking — daemon authority (capture, `SessionStore`, the P4b
   * coordinator).
   */
  handleActionFailure(params: {
    action: SessionAction;
    index: number;
    response: TResponse;
    artifactPaths: readonly string[];
    snapshotDiagnosticSamples: readonly SnapshotTimingSample[];
  }): Promise<TResponse>;
  /** Reads the artifact paths a response surfaced — wire-shape authority. */
  collectArtifactPaths(response: TResponse): readonly string[];
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

export type AdReplayRunOutcome<TResponse extends AdReplayResponse> =
  | Readonly<{
      readonly ok: true;
      readonly replayed: number;
      readonly artifactPaths: readonly string[];
      readonly snapshotDiagnosticSamples: readonly SnapshotTimingSample[];
    }>
  | Readonly<{ readonly ok: false; readonly response: TResponse }>;

/**
 * ADR 0012 step 4's step loop: for every executable action from
 * `request.entryIndex` on, arm the save-script transaction, skip a
 * repair-armed plan's terminal `close` (lifecycle, not a script step), report
 * progress, dispatch through `runtime.executeStep`, and stop at the first
 * failure. Moved verbatim from `executeReplayActions`'s composition order —
 * only the daemon capabilities it calls through were narrowed into
 * `runtime`.
 */
export async function runAdReplay<TResponse extends AdReplayResponse>(
  request: AdReplayRunRequest,
  runtime: AdReplayStepRuntime<TResponse>,
): Promise<AdReplayRunOutcome<TResponse>> {
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
    const response = await runtime.executeStep(action, index, [...artifactPaths]);
    snapshotDiagnosticSamples.push(...runtime.diagnosticsSince(sampleStart));
    runtime.collectArtifactPaths(response).forEach((entry) => artifactPaths.add(entry));
    if (response.ok) continue;
    const failure = await runtime.handleActionFailure({
      action,
      index,
      response,
      artifactPaths: [...artifactPaths],
      snapshotDiagnosticSamples,
    });
    return { ok: false, response: failure };
  }
  return {
    ok: true,
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
