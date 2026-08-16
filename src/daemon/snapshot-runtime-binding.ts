import {
  captureSnapshotUse,
  type BoundDeviceRuntime,
  type CaptureSnapshotInput,
} from '@agent-device/contracts/platform';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { buildIosOpenCommandHint } from './ios-app-session-hint.ts';
import { contextFromFlags } from './context.ts';
import { isIosSimulator } from './device-targets.ts';
import { resolveSessionDevice } from './handlers/snapshot-session.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import type { SessionStore } from './session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import {
  requireRuntimeBinding,
  requireRuntimeFacts,
  unavailableRuntimeOperationResponse,
} from './handlers/session-runtime-admission.ts';
import { errorResponse } from './handlers/response.ts';

type SnapshotCaptureAdmission =
  | Readonly<{ admitted: false; response: DaemonResponse }>
  | Readonly<{
      admitted: true;
      session: SessionState | undefined;
      device: SessionState['device'];
      providerOwned: boolean;
    }>;

/** Facts-first admission for the one public snapshot runtime unit. */
export async function inspectSnapshotCaptureAdmission(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
}): Promise<SnapshotCaptureAdmission> {
  const { session, device } = await resolveSessionDevice(
    params.sessionStore,
    params.sessionName,
    params.req.flags,
  );
  const facts = await requireRuntimeFacts(params.inspectFacts)(device);
  const unsupported = unavailableRuntimeOperationResponse(
    'snapshot',
    facts.operations.captureSnapshot,
  );
  if (unsupported) return { admitted: false, response: unsupported };
  return {
    admitted: true,
    session,
    device,
    providerOwned: facts.device.providerMode === 'provider-runtime',
  };
}

export async function bindSnapshotCaptureRuntime(
  bindDevice: BindDeviceRuntime | undefined,
  device: SessionState['device'],
): Promise<BoundDeviceRuntime<typeof captureSnapshotUse>> {
  return await requireRuntimeBinding(bindDevice)(device, captureSnapshotUse);
}

/** Flag/platform admission stays ahead of binding so invalid intent acquires no runtime. */
export function requireSnapshotCustomActionsSupported(
  req: DaemonRequest,
  device: DeviceInfo,
): DaemonResponse | null {
  if (req.flags?.snapshotCustomActions !== true || isIosSimulator(device)) return null;
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    `--actions requires an iOS simulator: custom actions are read through the private accessibility snapshot backend, which ${device.platform}/${device.kind} targets do not have.`,
    { hint: 'Re-run without --actions, or target an iOS simulator.' },
  );
}

export async function requireSnapshotIosAppSession(params: {
  command: 'snapshot' | 'diff';
  session: SessionState | undefined;
  device: SessionState['device'];
  providerOwned: boolean;
}): Promise<DaemonResponse | null> {
  const { command, session, device, providerOwned } = params;
  if (!isIosFamily(device) || session?.appBundleId || providerOwned) return null;
  const openCommandHint = await buildIosOpenCommandHint(device);
  return errorResponse(
    'SESSION_NOT_FOUND',
    `iOS ${command} requires an active app session on the target device. Run open first (for example: open --session ${session?.name ?? 'sim'} --platform ios --device "<name>" <app>).`,
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
