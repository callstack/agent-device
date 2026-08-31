import { prepareAppleRunnerRuntimeUse } from '@agent-device/contracts/application-lifecycle-runtime-plan';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { PREPARE_REQUEST_TIMEOUT_MS } from '../../core/command-descriptor/timeout-policy.ts';
import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { resolveRunnerLogicalLeaseContext } from '../lease-context.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { admitRuntimeUse } from '../runtime-admission.ts';
import {
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
} from '../session-device-resolution.ts';
import { errorResponse } from './response.ts';

const PREPARE_IOS_RUNNER_TIMING_NOTE =
  'Top-level prepare timing fields are diagnostic and may overlap; use timing.additiveParts for additive wall-clock phases.';

type PrepareRuntime = BoundDeviceRuntime<typeof prepareAppleRunnerRuntimeUse>;

// The sole facts admission and binding seam for `prepare`. The eager fact check never loads a
// backend implementation; only the selected owner is bound after its fact admits this operation.
async function admitPrepareRuntime(params: {
  device: DeviceInfo;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}) {
  return await admitRuntimeUse({
    ...params,
    command: 'prepare',
    use: prepareAppleRunnerRuntimeUse,
  });
}

export async function handlePrepareCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore } = params;
  const action = req.positionals?.[0] ?? '';
  if (action !== 'ios-runner') {
    return errorResponse('INVALID_ARGS', 'prepare requires a subcommand: ios-runner');
  }

  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const guard = requireSessionOrExplicitSelector(PUBLIC_COMMANDS.prepare, session, flags);
  if (guard) return guard;

  // Device selection is side-effect free enough for facts admission. The bound lifecycle owns
  // readiness, keeping provider-first facts as the sole support authority.
  const device = await resolveCommandDevice({ session, flags, ensureReady: false });
  const admission = await admitPrepareRuntime({
    device,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (admission.type === 'response') return admission.response;

  const startedAtMs = Date.now();
  const result = await admission.runtime.operations.prepareAppleRunner({
    timeoutMs: readPrepareIosRunnerTimeoutMs(req),
    execution: {
      requestId: req.meta?.requestId,
      logPath,
      traceLogPath: session?.trace?.outPath,
      verbose: req.flags?.verbose,
      iosXctestrunFile: req.flags?.iosXctestrunFile,
      iosXctestDerivedDataPath: req.flags?.iosXctestDerivedDataPath,
      iosXctestEnvDir: req.flags?.iosXctestEnvDir,
      runnerLeaseContext: resolveRunnerLogicalLeaseContext(req),
    },
  });
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  return {
    ok: true,
    data: prepareIosRunnerResponseData(action, device, durationMs, result),
  };
}

function readPrepareIosRunnerTimeoutMs(req: DaemonRequest): number {
  const value = req.flags?.timeoutMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : PREPARE_REQUEST_TIMEOUT_MS;
}

function prepareIosRunnerResponseData(
  action: string,
  device: DeviceInfo,
  durationMs: number,
  result: Awaited<ReturnType<PrepareRuntime['operations']['prepareAppleRunner']>>,
): Record<string, unknown> {
  return {
    action,
    platform: publicPlatformString(device),
    deviceId: device.id,
    deviceName: device.name,
    kind: device.kind,
    durationMs,
    ...result,
    timing: prepareIosRunnerTiming(durationMs, result),
    message: `Prepared Apple runner: ${device.name}`,
  };
}

function prepareIosRunnerTiming(
  durationMs: number,
  result: Awaited<ReturnType<PrepareRuntime['operations']['prepareAppleRunner']>>,
): Record<string, unknown> {
  const buildMs = normalizeOptionalTimingMs(result.buildMs);
  const connectMs = normalizeTimingMs(result.connectMs);
  const healthCheckMs = normalizeTimingMs(result.healthCheckMs);
  const additiveParts = {
    ...(buildMs === undefined ? {} : { buildMs }),
    connectAfterBuildMs: Math.max(0, connectMs - (buildMs ?? 0)),
    healthCheckMs,
  };

  return {
    totalMs: durationMs,
    additiveParts,
    containment:
      buildMs === undefined ? { healthCheckMs: [] } : { connectMs: ['buildMs'], healthCheckMs: [] },
    note: PREPARE_IOS_RUNNER_TIMING_NOTE,
  };
}

function normalizeOptionalTimingMs(value: number | undefined): number | undefined {
  return value === undefined ? undefined : normalizeTimingMs(value);
}

function normalizeTimingMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
