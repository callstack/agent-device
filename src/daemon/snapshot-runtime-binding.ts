import {
  type CaptureSnapshotInput,
  type RuntimeOperationFact,
  type SnapshotResult,
  type SnapshotRuntimeOperations,
  type SnapshotRuntimePlan,
} from '@agent-device/contracts/platform';
import { buildIosOpenCommandHint } from './ios-app-session-hint.ts';
import { contextFromFlags } from './context.ts';
import type { BindDeviceRuntime } from './request-runtime-binding.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import {
  requireRuntimeBinding,
  unavailableRuntimeOperationResponse,
} from './handlers/session-runtime-admission.ts';
import { errorResponse } from './handlers/response.ts';

export async function bindSnapshotCaptureRuntime(
  bindDevice: BindDeviceRuntime | undefined,
  device: SessionState['device'],
  plan: SnapshotRuntimePlan,
): Promise<Readonly<{ captureSnapshot(input: CaptureSnapshotInput): Promise<SnapshotResult> }>> {
  const bind = requireRuntimeBinding(bindDevice);
  switch (plan.kind) {
    case 'active-app': {
      const runtime = await bind(device, plan.use);
      return selectActiveAppSnapshot(runtime);
    }
    case 'custom-actions-active-app': {
      const runtime = await bind(device, plan.use);
      return selectCustomActionsSnapshot(runtime);
    }
    case 'without-active-app': {
      const runtime = await bind(device, plan.use);
      return selectSnapshotWithoutActiveApp(runtime);
    }
    case 'custom-actions-without-active-app': {
      const runtime = await bind(device, plan.use);
      return selectCustomActionsSnapshot(runtime);
    }
  }
}

type BoundSnapshotOperation<Operation extends keyof SnapshotRuntimeOperations> = Readonly<{
  operations: Readonly<Pick<SnapshotRuntimeOperations, Operation>>;
}>;

function selectActiveAppSnapshot(runtime: BoundSnapshotOperation<'captureSnapshot'>) {
  return Object.freeze({
    captureSnapshot: async (input: CaptureSnapshotInput) =>
      await runtime.operations.captureSnapshot(input),
  });
}

function selectCustomActionsSnapshot(
  runtime: BoundSnapshotOperation<'captureSnapshotWithCustomActions'>,
) {
  return Object.freeze({
    captureSnapshot: async (input: CaptureSnapshotInput) =>
      await runtime.operations.captureSnapshotWithCustomActions(input),
  });
}

function selectSnapshotWithoutActiveApp(
  runtime: BoundSnapshotOperation<'captureSnapshotWithoutActiveApp'>,
) {
  return Object.freeze({
    captureSnapshot: async (input: CaptureSnapshotInput) =>
      await runtime.operations.captureSnapshotWithoutActiveApp(input),
  });
}

export async function snapshotPlanUnavailableResponse(params: {
  operation: SnapshotRuntimePlan['use']['required'][number];
  fact: RuntimeOperationFact;
  session: SessionState | undefined;
  device: SessionState['device'];
}): Promise<DaemonResponse> {
  if (params.operation === 'captureSnapshot') {
    return unavailableRuntimeOperationResponse('snapshot', params.fact)!;
  }
  if (params.operation === 'captureSnapshotWithCustomActions') {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      `--actions requires an iOS simulator: custom actions are unavailable on this ${params.device.platform}/${params.device.kind} target.`,
      { reason: params.fact.available ? undefined : params.fact.reason },
      {
        hint:
          params.fact.available || !params.fact.hint
            ? 'Re-run without --actions, or target an iOS simulator.'
            : params.fact.hint,
      },
    );
  }
  const openCommandHint = await buildIosOpenCommandHint(params.device);
  return errorResponse(
    'SESSION_NOT_FOUND',
    `iOS snapshot requires an active app session on the target device. Run open first (for example: open --session ${params.session?.name ?? 'sim'} --platform ios --device "<name>" <app>).`,
    {
      reason: 'ios_app_session_required',
      ...(openCommandHint ? { hint: openCommandHint } : {}),
    },
  );
}

export function buildRuntimeCaptureInput(
  params: Readonly<{ req: DaemonRequest; logPath: string }>,
  session: SessionState | undefined,
  snapshotScope: string | undefined,
): CaptureSnapshotInput {
  const { req, logPath } = params;
  const context = contextFromFlags(
    logPath,
    req.flags,
    session?.appBundleId,
    session?.trace?.outPath,
    req.meta?.requestId,
    req.meta,
  );
  return {
    options: {
      appBundleId: session?.appBundleId,
      interactiveOnly: req.flags?.snapshotInteractiveOnly,
      preferredBackend: req.flags?.snapshotPreferredBackend,
      depth: req.flags?.snapshotDepth,
      scope: snapshotScope,
      raw: req.flags?.snapshotRaw,
      customActions: req.flags?.snapshotCustomActions,
      includeHiddenContentHints: req.flags?.snapshotIncludeHiddenContentHints,
      surface: session?.surface,
    },
    execution: {
      requestId: context.requestId,
      verbose: context.verbose,
      logPath: context.logPath,
      traceLogPath: context.traceLogPath,
      iosXctestrunFile: context.iosXctestrunFile,
      iosXctestDerivedDataPath: context.iosXctestDerivedDataPath,
      iosXctestEnvDir: context.iosXctestEnvDir,
      runnerLeaseContext: context.runnerLeaseContext,
    },
  };
}
