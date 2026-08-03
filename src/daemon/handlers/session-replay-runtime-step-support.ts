import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import { errorResponse } from './response.ts';
import { readReplaySelectorDisplayValue } from '../replay-selector-port.ts';
import type { ResponseLevel } from '@agent-device/kernel/contracts';
import type { ReplaySelectorPort } from '@agent-device/ad-replay';
import type { SnapshotTimingSample } from '@agent-device/contracts/capture';
import { withReplayFailureDiagnostics } from './session-replay-runtime-failure.ts';
import type { TargetBindingDivergenceContext } from './session-replay-target-verification.ts';
import type { ReplayCoordinator } from '../session-replay-coordinator.ts';

/**
 * #1555 structural-quality review ("shrink the runtime adapter toward the
 * plan's <300 LOC metric"): extracted out of
 * `session-replay-runtime-engine-adapter.ts` — `ReplayStepContext` (moved
 * here so both this module and the adapter can depend on it without a
 * cycle) plus the failure-wrapping and per-step diagnostics support
 * `createAdReplayStepRuntime`'s `handleActionFailure`/`describeStepValue`/
 * `diagnosticsMarker`/`diagnosticsSince` capabilities delegate to, none of
 * which touch the `lastResponse`/`lastObservation` side-map the factory
 * itself owns. The adapter re-exports `ReplayStepContext` by name so its
 * existing importers (`session-replay-runtime.ts`) see no path change.
 */

/**
 * Per-run invariants for a single replay step (ADR 0012 step 4 verify +
 * dispatch + guard). No `${VAR}` scope here (#1555 review P1, "move variable
 * semantics/planning behind the replay entrypoint") — the engine
 * (`runAdReplay`) builds and owns it; the adapter never resolves an action
 * or reads a scope value itself.
 */
export type ReplayStepContext = {
  replayReq: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  resolved: string;
  actions: SessionAction[];
  actionLines: number[];
  actionSourcePaths: (string | undefined)[] | undefined;
  planDigest: string;
  actionTracePath: string | undefined;
  responseLevel: ResponseLevel | undefined;
  invoke: DaemonInvokeFn;
  signal: AbortSignal | undefined;
  /** #1478 P4b: the one locked gateway to this request's repair transaction. */
  coordinator: ReplayCoordinator;
  /** #1478 P5 stage C: the one selector-port instance this request threads through the divergence-report chain. */
  port: ReplaySelectorPort;
};

/**
 * `runAdReplay` only ever calls `handleActionFailure` right after
 * `executeStep` reported `status: 'failed'`, and `executeStep` always sets
 * `lastResponse` to that same failed response before returning — so this
 * narrowing cannot actually fail in practice. The `COMMAND_FAILED` fallback
 * exists only so `buildReplayActionFailure` (which needs a real failed
 * response to wrap) stays total if that invariant is ever violated.
 */
export function asFailedReplayStepResponse(
  response: DaemonResponse | undefined,
): Extract<DaemonResponse, { ok: false }> {
  if (response && !response.ok) return response;
  return errorResponse(
    'COMMAND_FAILED',
    'replay step reported failure with no recorded response',
  ) as Extract<DaemonResponse, { ok: false }>;
}

export async function buildReplayActionFailure(
  ctx: ReplayStepContext,
  req: DaemonRequest,
  action: SessionAction,
  index: number,
  response: Extract<DaemonResponse, { ok: false }>,
  artifactPaths: string[],
  snapshotDiagnosticSamples: SnapshotTimingSample[],
  scrubVars: TargetBindingDivergenceContext['scrubVars'],
): Promise<DaemonResponse> {
  const heldResponse = (failure: DaemonResponse): DaemonResponse =>
    ctx.coordinator.markSessionHeldIfArmed(failure);
  if (isCompleteTargetBindingDivergenceResponse(response)) return heldResponse(response);
  return heldResponse(
    await withReplayFailureDiagnostics({
      response,
      action,
      index,
      replayPath: ctx.resolved,
      sourcePath: ctx.actionSourcePaths?.[index] ?? ctx.resolved,
      sourceLine: ctx.actionLines[index] ?? 1,
      artifactPaths,
      snapshotDiagnosticSamples,
      scrubVars,
      req,
      sessionName: ctx.sessionName,
      sessionStore: ctx.sessionStore,
      resumeStamper: ctx.coordinator.resumeStamper,
      logPath: ctx.logPath,
      planActions: ctx.actions,
      planDigest: ctx.planDigest,
      port: ctx.port,
    }),
  );
}

/**
 * A replay-test progress step's display value: the recorded selector's
 * label/text/id term value when every alternative agrees on ONE value, else
 * `undefined`. Needs `readReplaySelectorDisplayValue`'s private selector AST
 * (`replay-selector-port.ts` deliberately keeps it daemon-only — see that
 * file's own comment), so this stays daemon-side and is handed to the engine
 * loop as the narrow `describeStepValue` capability.
 */
export function describeReplayStepValue(action: SessionAction): string | undefined {
  const positionals = action.positionals ?? [];
  const selectorValue = readReplaySelectorDisplayValue(positionals[0]);
  if (selectorValue) return selectorValue;
  if (positionals.length === 0) return undefined;
  return positionals.join(' ');
}

// ADR 0012 step 4: a target-binding divergence is already a complete, final
// REPLAY_DIVERGENCE built from its own pre-action capture — distinguished from
// an action-failure divergence by its non-`action-failure` kind. Pinned
// daemon-side: it re-inspects the already-projected `DaemonResponse` wire
// shape to decide whether the wire-level diagnostics-augmentation step
// applies, which is daemon/wire authority, not engine divergence-kind
// classification (that already happened engine-side, in
// `classifyReplayTarget`/`target-identity.ts`).
function isCompleteTargetBindingDivergenceResponse(response: DaemonResponse): boolean {
  if (response.ok || response.error.code !== 'REPLAY_DIVERGENCE') return false;
  const divergence = response.error.details?.divergence;
  const kind =
    divergence && typeof divergence === 'object'
      ? (divergence as Record<string, unknown>).kind
      : undefined;
  return typeof kind === 'string' && kind !== 'action-failure';
}

export function readSessionSnapshotSampleCount(
  sessionStore: SessionStore,
  sessionName: string,
): number {
  return sessionStore.get(sessionName)?.snapshotDiagnostics?.samples.length ?? 0;
}

export function readSessionSnapshotSamplesSince(
  sessionStore: SessionStore,
  sessionName: string,
  start: number,
): SnapshotTimingSample[] {
  return sessionStore.get(sessionName)?.snapshotDiagnostics?.samples.slice(start) ?? [];
}
