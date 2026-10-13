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
 * The capture a post-action observation (`--settle`) polls, for a request whose own action binding
 * carries none: a coordinate-targeted `press`/`fill` (whose point use declares none) or a
 * generic-route action (#3510). Those routes polled the legacy interactor while the commands the
 * caller runs next read the request-bound runtime, and on an iOS simulator those are two projections
 * of one tree.
 *
 * Admitting the `capture-only` plan the selector family polls under closes the split; where both
 * paths already reached the same tree, the admitted operation resolves to the implementation used
 * before. Settling is best-effort by contract, so nothing here may fail or cancel the action it
 * follows: every unavailability degrades to `undefined`, leaving the observation on the owner's own
 * snapshot path, and discloses its typed reason. Admitting through the side-effect-free facts probe
 * and binding only on admission keeps an optional observation from building a command-facing refusal
 * response, whose Apple branch live-probes the booted simulator set for a hint nothing shows.
 */
export async function resolveSettleObservationCapture(
  params: Readonly<{ command: string; session: SessionState }> & RuntimeAdmissionBindings,
): Promise<BoundSnapshotCapture | undefined> {
  const plan = resolveSelectorCaptureRuntimePlan({
    hasActiveApp: params.session.appBundleId !== undefined,
    intent: 'capture-only',
  });
  const admission = await admitObservationCapturePlan(params, plan);
  if (admission === undefined) return undefined;
  if (!admission.admitted) {
    return unavailable({
      command: params.command,
      outcome: 'refused',
      operation: admission.operation,
      reason: admission.fact.reason,
    });
  }
  try {
    return await bindAdmittedSnapshotCapture({
      admission,
      bindDevice: params.bindDevice,
      platformServices: params.platformServices,
    });
  } catch (error) {
    return unavailable({ command: params.command, outcome: 'bind-failed', error });
  }
}

/** `undefined` means the owner's facts probe failed: the caller degrades like any other refusal. */
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
    return unavailable({ command: params.command, outcome: 'admission-probe-failed', error });
  }
}

/** Why the observation has to go without a capture, as one typed fact the caller can read. */
type ObservationCaptureUnavailable = Readonly<{ command: string }> &
  (
    | Readonly<{
        outcome: 'refused';
        operation: string;
        reason: RuntimeOperationUnavailability['reason'];
      }>
    | Readonly<{ outcome: 'admission-probe-failed' | 'bind-failed'; error: unknown }>
  );

function unavailable(detail: ObservationCaptureUnavailable): undefined {
  emitDiagnostic({
    // `warn`, not the default `info`: a degrade that answers `ok: true` is dropped at info level on
    // the success path, which is the passing-unnoticed this discloses against.
    level: 'warn',
    phase: 'settle_observation_capture_unavailable',
    // The error's name travels, never its message: request diagnostics keep user input out.
    data:
      detail.outcome === 'refused'
        ? { ...detail }
        : {
            command: detail.command,
            outcome: detail.outcome,
            errorName: (detail.error as Error | undefined)?.name,
          },
  });
  return undefined;
}
