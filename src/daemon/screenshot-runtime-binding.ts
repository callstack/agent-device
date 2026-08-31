import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import {
  type ScreenshotRuntimePlan,
  resolveScreenshotRuntimePlan,
} from '@agent-device/contracts/platform-runtime-operations';
import type {
  CaptureScreenshotInput,
  ScreenshotRuntimeOperations,
} from '@agent-device/contracts/screenshot-runtime';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
  SnapshotRuntimeOperations,
} from '@agent-device/contracts/snapshot-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { errorResponse } from './response.ts';
import {
  admitRuntimePlan,
  requireRuntimeBinding,
  unavailableRuntimeOperationResponse,
  unwrapAdmittedRuntimePlan,
  type AdmittedRuntimePlan,
} from './session-runtime-admission.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import type { DaemonResponse } from './types.ts';

export type ScreenshotRuntimeBindings = Readonly<{
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}>;

/**
 * One request's admitted capture authority. `captureSnapshot` is present exactly when the
 * overlay-refs plan was admitted, so a caller cannot annotate a capture it never declared — and
 * both operations come from the same single binding.
 */
export type BoundScreenshotRuntime = Readonly<{
  captureScreenshot(input: CaptureScreenshotInput): Promise<void>;
  captureSnapshot?: (input: CaptureSnapshotInput) => Promise<SnapshotResult>;
}>;

export type ResolvedScreenshotRuntime =
  | Readonly<{ ok: true; runtime: BoundScreenshotRuntime }>
  | Readonly<{ ok: false; response: DaemonResponse }>;

/** Resolves one plan, inspects its owner facts once, then binds once on the admitted device. */
export async function resolveBoundScreenshotRuntime(
  params: Readonly<{ device: DeviceInfo; overlayRefs: boolean }> & ScreenshotRuntimeBindings,
): Promise<ResolvedScreenshotRuntime> {
  const plan = resolveScreenshotRuntimePlan({ overlayRefs: params.overlayRefs });
  const admission = await admitRuntimePlan({
    device: params.device,
    plan,
    inspectFacts: params.inspectFacts,
  });
  if (!admission.admitted) {
    return {
      ok: false,
      response: screenshotPlanUnavailableResponse(admission.operation, admission.fact),
    };
  }
  return { ok: true, runtime: await bindScreenshotRuntime(params.bindDevice, admission) };
}

/**
 * Binds only an admitted plan, on the device it was admitted for: the token is minted by
 * `admitRuntimePlan` alone and unwrapped by exact identity, so nothing that was not admitted can
 * reach the capture operations.
 */
async function bindScreenshotRuntime(
  bindDevice: BindDeviceRuntime | undefined,
  admission: AdmittedRuntimePlan<ScreenshotRuntimePlan>,
): Promise<BoundScreenshotRuntime> {
  const bind = requireRuntimeBinding(bindDevice);
  const { device, plan } = unwrapAdmittedRuntimePlan(admission);
  switch (plan.kind) {
    case 'capture': {
      const runtime = await bind(device, plan.use);
      return Object.freeze({ captureScreenshot: selectScreenshotCapture(runtime) });
    }
    case 'capture-with-overlay-refs': {
      const runtime = await bind(device, plan.use);
      return Object.freeze({
        captureScreenshot: selectScreenshotCapture(runtime),
        captureSnapshot: selectOverlaySnapshot(runtime),
      });
    }
  }
}

type BoundScreenshotOperation<Operation extends keyof ScreenshotRuntimeOperations> = Readonly<{
  operations: Readonly<Pick<ScreenshotRuntimeOperations, Operation>>;
}>;

/** The one narrowed capture call every screenshot plan funnels through. */
function selectScreenshotCapture(runtime: BoundScreenshotOperation<'captureScreenshot'>) {
  return async (input: CaptureScreenshotInput) => await runtime.operations.captureScreenshot(input);
}

/** The overlay plan's tree read, from the same binding as its capture. */
function selectOverlaySnapshot(
  runtime: Readonly<{ operations: Readonly<Pick<SnapshotRuntimeOperations, 'captureSnapshot'>> }>,
) {
  return async (input: CaptureSnapshotInput) => await runtime.operations.captureSnapshot(input);
}

function screenshotPlanUnavailableResponse(
  operation: ScreenshotRuntimePlan['use']['required'][number],
  fact: RuntimeOperationFact,
): DaemonResponse {
  if (operation === 'captureScreenshot') {
    return unavailableRuntimeOperationResponse('screenshot', fact)!;
  }
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    '--overlay-refs annotates a capture with the refs of a snapshot taken on the same screen, which this target cannot capture.',
    { reason: fact.available ? undefined : fact.reason },
    {
      hint: (fact.available ? undefined : fact.hint) ?? 'Re-run screenshot without --overlay-refs.',
    },
  );
}
