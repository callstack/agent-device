import path from 'node:path';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { isIosFamily, publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitRequestProgress } from '@agent-device/host-kit/request';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
import {
  listLocalDeviceInventory,
  shouldPropagateDeviceInventoryProbeError,
} from '../../request/device-inventory-context.ts';
import { readVersion } from '@agent-device/host-kit/version';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { appendAppChecks, type DoctorAppInventory } from './session-doctor-app.ts';
import {
  appendDeviceInventoryCheck,
  type DoctorDeviceInventory,
  resolveDoctorDeviceForAppCheck,
} from './session-doctor-device.ts';
import { probeMetro } from './session-doctor-metro.ts';
import {
  readDoctorOptions,
  remoteConnectionChecks,
  sessionChecks,
} from './session-doctor-options.ts';
import {
  appendDoctorCheck,
  appendDoctorChecks,
  doctorSummary,
  sortChecks,
  summarizeDoctorStatus,
} from './session-doctor-output.ts';
import type { DoctorOptions } from './session-doctor-types.ts';
import type { DoctorCheck, DoctorCommandResult } from '@agent-device/contracts/observability';
import type {
  HostDiagnostics,
  HostDiagnosticsContext,
} from '@agent-device/contracts/host-diagnostics';
import { resolveAndroidSerialAllowlist } from '@agent-device/kernel/device-isolation';
import type { InstalledAppInfo } from '@agent-device/contracts/app-inventory-runtime';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import { appsRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { ensureAppsRuntimeReady, listAppsFromRuntime } from '../apps-runtime.ts';

export async function handleDoctorCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  /** Opaque provider-scope transport override; the android family narrows it back. */
  androidAdbExecutor?: unknown;
  hostDiagnostics?: HostDiagnostics;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore, androidAdbExecutor, inspectFacts, bindDevice } = params;
  if (req.command !== PUBLIC_COMMANDS.doctor) return null;
  const hostDiagnostics = requireHostDiagnostics(params.hostDiagnostics);

  const session = sessionStore.get(sessionName);
  const options = readDoctorOptions(req, session);
  const stateDir = resolveDoctorStateDir(sessionStore, sessionName);
  const checks: DoctorCheck[] = [];
  appendDoctorChecks(
    checks,
    {
      id: 'agent-device',
      status: 'pass',
      summary: `agent-device ${readVersion()} using ${stateDir}`,
      evidence: { version: readVersion(), stateDir },
    },
    ...remoteConnectionChecks(req, { required: options.remote }),
    ...sessionChecks(sessionStore, sessionName, session, { remote: options.remote }),
  );

  if (options.remote) {
    return doctorResponse(checks, options);
  }

  const context = hostDiagnosticsContext(options, stateDir, androidAdbExecutor);
  const inventory = await appendDeviceInventoryCheck(checks, req, session);
  const toolchain = await hostDiagnostics.toolchainCheck(
    session?.device.platform ?? inventory?.platform,
    context,
  );
  if (toolchain) appendDoctorCheck(checks, toolchain);
  const appCheckDevice = await appendLocalDoctorChecks({
    checks,
    context,
    hostDiagnostics,
    inventory,
    options,
    session,
    inspectFacts,
    bindDevice,
    req,
  });
  const warmupDevice = appCheckDevice ?? resolveWarmupSimulator(inventory);
  if (warmupDevice) {
    const warmup = await hostDiagnostics.warmupCheck(warmupDevice, context);
    if (warmup) appendDoctorCheck(checks, warmup);
  }
  return doctorResponse(checks, options, { device: appCheckDevice, includeMetro: true, inventory });
}

function requireHostDiagnostics(value: HostDiagnostics | undefined): HostDiagnostics {
  if (!value) {
    throw new AppError('COMMAND_FAILED', 'Host diagnostics gateway is not configured', {
      reason: 'runtime-gateway-missing',
    });
  }
  return value;
}

function hostDiagnosticsContext(
  options: DoctorOptions,
  stateDir: string,
  androidAdbExecutor: unknown,
): HostDiagnosticsContext {
  return Object.freeze({
    stateDir,
    metroPort: options.metroPort,
    shouldProbeMetro: options.shouldProbeMetro,
    isProviderDevice: (device: DeviceInfo) => isActiveProviderDevice(device),
    emitProgress: (message: string) =>
      emitRequestProgress({ type: 'command', status: 'progress', message }),
    listLocalDeviceInventory: async (query: Parameters<typeof listLocalDeviceInventory>[0]) =>
      await listLocalDeviceInventory(query),
    shouldPropagateInventoryProbeError: shouldPropagateDeviceInventoryProbeError,
    transportOverrides: Object.freeze({ androidAdb: androidAdbExecutor }),
  });
}

// Doctor doubles as the fresh-machine warmup: when an iOS simulator is in
// scope and the runner artifact is not built yet, kick the build in the
// background so the first `open` skips the ~10s xcodebuild build. The check
// line makes the warmup visible either way. Any simulator record works as
// the build device — the artifact builds against a generic simulator
// destination and is shared across simulators and runtimes.
function resolveWarmupSimulator(
  inventory: DoctorDeviceInventory | undefined,
): DeviceInfo | undefined {
  const simulators = (inventory?.devices ?? []).filter(
    (device) => isIosFamily(device) && device.kind === 'simulator',
  );
  return simulators.find((device) => device.booted === true) ?? simulators[0];
}

function resolveDoctorStateDir(sessionStore: SessionStore, sessionName: string): string {
  const sessionsDir = path.dirname(sessionStore.resolveSessionDir(sessionName));
  return path.basename(sessionsDir) === 'sessions' ? path.dirname(sessionsDir) : sessionsDir;
}

async function appendLocalDoctorChecks(params: {
  checks: DoctorCheck[];
  context: HostDiagnosticsContext;
  hostDiagnostics: HostDiagnostics;
  inventory: DoctorDeviceInventory | undefined;
  options: DoctorOptions;
  session: SessionState | undefined;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  req: DaemonRequest;
}): Promise<DeviceInfo | undefined> {
  const {
    checks,
    context,
    hostDiagnostics,
    inventory,
    options,
    session,
    inspectFacts,
    bindDevice,
    req,
  } = params;
  const appCheckDevice =
    session?.device ?? resolveDoctorDeviceForAppCheck(checks, inventory, options.targetApp);
  if (appCheckDevice) {
    await appendDeviceScopedDoctorChecks(checks, {
      context,
      hostDiagnostics,
      device: appCheckDevice,
      options,
      session,
      inspectFacts,
      bindDevice,
      req,
    });
  }
  if (options.shouldProbeMetro) {
    appendDoctorCheck(checks, await probeMetro(options.metroHost, options.metroPort, options.kind));
  }
  appendDoctorChecks(checks, ...(await hostDiagnostics.ambientChecks(context)));
  return appCheckDevice;
}

async function appendDeviceScopedDoctorChecks(
  checks: DoctorCheck[],
  params: {
    context: HostDiagnosticsContext;
    hostDiagnostics: HostDiagnostics;
    device: DeviceInfo;
    options: DoctorOptions;
    session: SessionState | undefined;
    inspectFacts?: InspectDeviceRuntimeFacts;
    bindDevice?: BindDeviceRuntime;
    req: DaemonRequest;
  },
): Promise<void> {
  const { context, hostDiagnostics, device, options, session, inspectFacts, bindDevice, req } =
    params;
  let listInstalledApps: DoctorAppInventory | undefined;
  try {
    listInstalledApps = await resolveDoctorAppInventoryForDoctor({
      device,
      req,
      targetApp: options.targetApp,
      inspectFacts,
      bindDevice,
    });
  } catch (error) {
    // Keep facts/bind/readiness failures inside appendAppChecks' accumulator path so doctor
    // reports a failed target-app check and still runs the remaining device checks.
    listInstalledApps = async () => {
      throw error;
    };
  }
  await appendAppChecks(checks, {
    device,
    session,
    targetApp: options.targetApp,
    listInstalledApps,
  });
  appendDoctorChecks(checks, ...(await hostDiagnostics.deviceChecks(device, context)));
}

async function resolveDoctorAppInventoryForDoctor(
  params: Parameters<typeof resolveDoctorAppInventory>[0],
): ReturnType<typeof resolveDoctorAppInventory> {
  // Doctor's target-app check preserves its legacy HarmonyOS informational cell; this does not
  // alter the apps command's facts or runtime binding, which remain available independently.
  if (params.device.platform === 'harmonyos') return undefined;
  return resolveDoctorAppInventory(params);
}

async function resolveDoctorAppInventory(params: {
  device: DeviceInfo;
  req: DaemonRequest;
  targetApp?: string;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<
  ((filter: 'all' | 'user-installed') => Promise<readonly InstalledAppInfo[]>) | undefined
> {
  const { device, req, targetApp, inspectFacts, bindDevice } = params;
  if (!targetApp || !inspectFacts || !bindDevice) {
    return undefined;
  }
  const facts = await inspectFacts(device);
  const appFact = facts.operations.listApps;
  const readyFact = facts.operations.ensureReady;
  if (!appFact.available || !readyFact.available) return undefined;
  const runtime: BoundDeviceRuntime<typeof appsRuntimeUse> = await bindDevice(
    device,
    appsRuntimeUse,
  );
  const androidSerialAllowlist = resolveAndroidSerialAllowlist(req.flags?.androidDeviceAllowlist);
  const readyDevice = await ensureAppsRuntimeReady(runtime, {
    serial: req.flags?.serial,
    androidSerialAllowlist: androidSerialAllowlist ? [...androidSerialAllowlist].sort() : undefined,
  });
  return async (filter) => await listAppsFromRuntime(runtime, readyDevice, filter);
}

function doctorResponse(
  checks: DoctorCheck[],
  options: DoctorOptions,
  scope: { device?: DeviceInfo; includeMetro?: boolean; inventory?: DoctorDeviceInventory } = {},
): DaemonResponse {
  const status = summarizeDoctorStatus(checks);
  return {
    ok: true,
    data: {
      status,
      summary: doctorSummary(status),
      kind: options.kind,
      // approach (b): a resolved/bound device projects to the PUBLIC leaf platform
      // (ios/macos), never the internal `apple`. Falls back to the raw inventory
      // SELECTOR (a user-supplied `--platform` value, which is already a leaf or an
      // explicit `apple` selector the caller typed) when no device was resolved.
      platform: scope.device ? publicPlatformString(scope.device) : scope.inventory?.platform,
      target: scope.device?.target ?? scope.inventory?.target,
      targetApp: options.targetApp,
      metro:
        scope.includeMetro && options.shouldProbeMetro
          ? { host: options.metroHost, port: options.metroPort }
          : undefined,
      checks: sortChecks(checks),
    } satisfies DoctorCommandResult,
  };
}
