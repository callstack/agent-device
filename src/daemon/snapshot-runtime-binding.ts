import {
  resolveSnapshotRuntimePlan,
  type CaptureSnapshotInput,
  type RuntimeOperationFact,
  type SnapshotResult,
  type SnapshotRuntimeOperations,
  type SnapshotRuntimePlan,
} from '@agent-device/contracts/platform';
import { buildIosOpenCommandHint } from './ios-app-session-hint.ts';
import { contextFromFlags } from './context.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import { SessionStore } from './session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import {
  admitRuntimePlan,
  requireRuntimeBinding,
  unavailableRuntimeOperationResponse,
  unwrapAdmittedRuntimePlan,
  type AdmittedRuntimePlan,
} from './handlers/session-runtime-admission.ts';
import { errorResponse } from './handlers/response.ts';
import { resolveSnapshotScope } from './handlers/snapshot-capture.ts';
import { resolveSessionDevice } from './handlers/snapshot-session.ts';

export type SnapshotRuntimeRouteParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
};

type ResolvedSnapshotCaptureRuntime =
  | Readonly<{
      ok: true;
      session: SessionState | undefined;
      device: SessionState['device'];
      snapshotScope: string | undefined;
      captureSnapshot: () => Promise<SnapshotResult>;
    }>
  | Readonly<{ ok: false; response: DaemonResponse }>;

/** Resolves one plan, inspects its owner facts once, then returns one bound capture closure. */
export async function resolveBoundSnapshotCaptureRuntime(
  params: SnapshotRuntimeRouteParams,
  command: 'snapshot' | 'diff',
): Promise<ResolvedSnapshotCaptureRuntime> {
  const { req, sessionName, sessionStore } = params;
  const { session, device } = await resolveSessionDevice(sessionStore, sessionName, req.flags);
  const resolvedScope = resolveSnapshotScope(req.flags?.snapshotScope, session);
  if (!resolvedScope.ok) return { ok: false, response: resolvedScope };

  const plan = resolveSnapshotRuntimePlan({
    customActions: req.flags?.snapshotCustomActions === true,
    hasActiveApp: session?.appBundleId !== undefined,
  });
  const admission = await admitRuntimePlan({ device, plan, inspectFacts: params.inspectFacts });
  if (!admission.admitted) {
    return {
      ok: false,
      response: await snapshotPlanUnavailableResponse({
        operation: admission.operation,
        fact: admission.fact,
        session,
        device,
        command,
      }),
    };
  }

  const runtime = await bindSnapshotCaptureRuntime(params.bindDevice, admission);
  const captureInput = buildRuntimeCaptureInput(params, session, resolvedScope.scope);
  return Object.freeze({
    ok: true,
    session,
    device,
    snapshotScope: resolvedScope.scope,
    captureSnapshot: async () => await runtime.captureSnapshot(captureInput),
  });
}

/**
 * Binds only an admitted plan, on the device it was admitted for: the token is minted by
 * `admitRuntimePlan` alone and unwrapped by exact identity, so nothing that was not admitted —
 * a bare plan, a separate device, a look-alike or Proxy — can reach the capture operations.
 */
async function bindSnapshotCaptureRuntime(
  bindDevice: BindDeviceRuntime | undefined,
  admission: AdmittedRuntimePlan<SnapshotRuntimePlan>,
): Promise<Readonly<{ captureSnapshot(input: CaptureSnapshotInput): Promise<SnapshotResult> }>> {
  const bind = requireRuntimeBinding(bindDevice);
  const { device, plan } = unwrapAdmittedRuntimePlan(admission);
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

type SnapshotPlanUnavailableParams = {
  operation: SnapshotRuntimePlan['use']['required'][number];
  fact: RuntimeOperationFact;
  session: SessionState | undefined;
  device: SessionState['device'];
  command: 'snapshot' | 'diff';
};

async function snapshotPlanUnavailableResponse(
  params: SnapshotPlanUnavailableParams,
): Promise<DaemonResponse> {
  if (params.operation === 'captureSnapshot') {
    return unavailableRuntimeOperationResponse(params.command, params.fact)!;
  }
  if (params.operation === 'captureSnapshotWithCustomActions') {
    return snapshotCustomActionsUnavailableResponse(params);
  }
  const openCommandHint = await buildIosOpenCommandHint(params.device);
  return errorResponse(
    'SESSION_NOT_FOUND',
    `iOS ${params.command} requires an active app session on the target device. Run open first (for example: open --session ${params.session?.name ?? 'sim'} --platform ios --device "<name>" <app>).`,
    {
      reason: 'ios_app_session_required',
      ...(openCommandHint ? { hint: openCommandHint } : {}),
    },
  );
}

function snapshotCustomActionsUnavailableResponse(
  params: SnapshotPlanUnavailableParams,
): DaemonResponse {
  const unavailableMessage =
    params.command === 'diff'
      ? `--actions requires an iOS simulator: custom actions are read through the private accessibility snapshot backend, which ${params.device.platform}/${params.device.kind} targets do not have.`
      : `--actions requires an iOS simulator: custom actions are unavailable on this ${params.device.platform}/${params.device.kind} target.`;
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    unavailableMessage,
    { reason: params.fact.available ? undefined : params.fact.reason },
    {
      hint:
        params.command === 'diff' || params.fact.available || !params.fact.hint
          ? 'Re-run without --actions, or target an iOS simulator.'
          : params.fact.hint,
    },
  );
}

function buildRuntimeCaptureInput(
  params: Readonly<{ req: DaemonRequest; logPath: string }>,
  session: SessionState | undefined,
  snapshotScope: string | undefined,
): CaptureSnapshotInput {
  const { req, logPath } = params;
  const flags = req.flags ?? {};
  const { appBundleId, trace, surface } = session ?? {};
  const { requestId } = req.meta ?? {};
  const context = contextFromFlags(
    logPath,
    flags,
    appBundleId,
    trace?.outPath,
    requestId,
    req.meta,
  );
  return {
    options: {
      appBundleId,
      interactiveOnly: flags.snapshotInteractiveOnly,
      preferredBackend: flags.snapshotPreferredBackend,
      depth: flags.snapshotDepth,
      scope: snapshotScope,
      raw: flags.snapshotRaw,
      customActions: flags.snapshotCustomActions,
      includeHiddenContentHints: flags.snapshotIncludeHiddenContentHints,
      surface,
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
