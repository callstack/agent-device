import type { BoundSnapshotCapture } from './snapshot-runtime-binding.ts';
import { bindAdmittedSnapshotCapture } from './snapshot-runtime-binding.ts';
import { admitRuntimePlan } from './session-runtime-admission.ts';
import {
  resolveSelectorCaptureRuntimePlan,
  type SelectorCaptureRuntimePlan,
} from '@agent-device/contracts/platform-runtime-operations';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { RuntimeOperationUnavailability } from '@agent-device/contracts/platform-runtime';
import type { RuntimeAdmissionBindings } from './request-runtime-binding.ts';
import type { SessionState } from './session-state.ts';

/**
 * The request-bound capture for an internal observation, on a request whose own action binding
 * carries none: a coordinate-targeted `press`/`fill` (whose point use declares none) or a
 * generic-route action (#3510). Those routes polled the legacy interactor while the commands the
 * caller runs next read the request-bound runtime, and on an iOS simulator those are two projections
 * of one tree.
 *
 * Admitting the `capture-only` plan the selector family polls under closes the split; where both
 * paths already reached the same tree, the admitted operation resolves to the implementation used
 * before. Observing is best-effort by contract, so nothing here may fail or cancel the work it
 * follows: the result is one of three mutually exclusive kinds — a bound `capture`, a `refused`
 * fact about the owner's declared support, or a `retryable` probe or bind failure. A caller that
 * reuses the answer across observations keeps `refused` until its plan changes and re-probes only
 * on `retryable`; it never restates what a probe or bind cost the observation. Every kind is
 * disclosed where it is decided: `admitted` and `bound` at info, so a request's own record shows
 * which cells reached a runtime capture, and the loss kinds at `warn` — an info-only degrade on a
 * route that answers `ok: true` is dropped on the success path, which is the passing-unnoticed the
 * loss disclosures guard against. Admitting through the side-effect-free facts probe and binding
 * only on admission keeps an optional observation from building a command-facing refusal response,
 * whose Apple branch live-probes the booted simulator set for a hint nothing shows.
 */
export async function resolveObservationCapture(
  params: Readonly<{ command: string; session: SessionState }> & RuntimeAdmissionBindings,
): Promise<ObservationCaptureOutcome> {
  const plan = resolveSelectorCaptureRuntimePlan({
    hasActiveApp: params.session.appBundleId !== undefined,
    intent: 'capture-only',
  });
  const admission = await admitObservationCapturePlan(params, plan);
  if (admission === undefined) return { kind: 'retryable' };
  if (!admission.admitted) {
    return refused({
      command: params.command,
      operation: admission.operation,
      reason: admission.fact.reason,
    });
  }
  emitDiagnostic({
    level: 'info',
    phase: 'observation_capture_admitted',
    data: { command: params.command, plan: plan.kind, deviceId: params.session.device.id },
  });
  try {
    const capture = await bindAdmittedSnapshotCapture({
      admission,
      bindDevice: params.bindDevice,
      platformServices: params.platformServices,
    });
    emitDiagnostic({
      level: 'info',
      phase: 'observation_capture_bound',
      data: { command: params.command, plan: plan.kind, deviceId: params.session.device.id },
    });
    return { kind: 'captured', capture };
  } catch (error) {
    return retryable({ command: params.command, failure: 'bind-failed', error });
  }
}

/** A failed facts probe is the owner's own machinery failing: the retryable kind, disclosed once here. */
async function admitObservationCapturePlan(
  params: Readonly<{ command: string; session: SessionState }> & RuntimeAdmissionBindings,
  plan: SelectorCaptureRuntimePlan,
) {
  try {
    return await admitRuntimePlan({
      device: params.session.device,
      plan,
      inspectFacts: params.inspectFacts,
    });
  } catch (error) {
    retryable({ command: params.command, failure: 'admission-probe-failed', error });
    return undefined;
  }
}

/** The three mutually exclusive answers; each carries only what its own branch decided. */
export type ObservationCaptureOutcome =
  | Readonly<{ kind: 'captured'; capture: BoundSnapshotCapture }>
  | Readonly<{ kind: 'refused' }>
  | Readonly<{ kind: 'retryable' }>;

/** Discloses the declared refusal; the caller keeps it while its plan is unchanged. */
function refused(detail: {
  command: string;
  operation: string;
  reason: RuntimeOperationUnavailability['reason'];
}): Readonly<{ kind: 'refused' }> {
  emitDiagnostic({
    level: 'warn',
    phase: 'observation_capture_unavailable',
    data: { ...detail, outcome: 'refused' },
  });
  return { kind: 'refused' };
}

/** Discloses a failure of the owner's own machinery; the caller may try again at the next observation. */
function retryable(detail: {
  command: string;
  failure: 'admission-probe-failed' | 'bind-failed';
  error: unknown;
}): Readonly<{ kind: 'retryable' }> {
  emitDiagnostic({
    // `warn`, not info: a degrade on a route that answers `ok: true` must survive the success-path filter.
    level: 'warn',
    phase: 'observation_capture_unavailable',
    // The error's name travels, never its message: request diagnostics keep user input out.
    data: {
      command: detail.command,
      outcome: detail.failure,
      errorName: (detail.error as Error | undefined)?.name,
    },
  });
  return { kind: 'retryable' };
}
