import path from 'node:path';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import { isIosFamily, publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { emitRequestProgress } from '../../request/progress.ts';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
import { readVersion } from '../../utils/version.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { appendAndroidChecks } from './session-doctor-android.ts';
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
import { appendToolchainChecks } from './session-doctor-toolchain.ts';
import type { DoctorOptions } from './session-doctor-types.ts';
import type { DoctorCheck, DoctorCommandResult } from '@agent-device/contracts/observability';
import {
  hasCachedAppleRunnerArtifact,
  prewarmAppleRunnerCache,
} from '../../platforms/apple/core/runner/runner-client.ts';
import { appendWebBrowserLifecycleCheck } from './session-doctor-web.ts';
import { resolveAndroidSerialAllowlist } from '../../utils/device-isolation.ts';
import type { InstalledAppInfo } from '@agent-device/contracts/app-inventory-runtime';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import { appsRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { ensureAppsRuntimeReady, listAppsFromRuntime } from '../apps-runtime.ts';

export async function handleDoctorCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  androidAdbExecutor?: AndroidAdbExecutor;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore, androidAdbExecutor, inspectFacts, bindDevice } = params;
  if (req.command !== PUBLIC_COMMANDS.doctor) return null;

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

  const inventory = await appendDeviceInventoryCheck(checks, req, session);
  await appendToolchainChecks(checks, session?.device.platform ?? inventory?.platform);
  const appCheckDevice = await appendLocalDoctorChecks({
    androidAdbExecutor,
    checks,
    inventory,
    options,
    session,
    stateDir,
    inspectFacts,
    bindDevice,
    req,
  });
  await appendIosRunnerWarmupCheck(checks, appCheckDevice ?? resolveWarmupSimulator(inventory));
  return doctorResponse(checks, options, { device: appCheckDevice, includeMetro: true, inventory });
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

async function appendIosRunnerWarmupCheck(
  checks: DoctorCheck[],
  device: DeviceInfo | undefined,
): Promise<void> {
  if (!device || !isIosFamily(device) || device.kind !== 'simulator') return;
  // The warmup drives local xcodebuild: skip on non-macOS hosts and for
  // provider-backed devices, whose runner lives with the remote daemon.
  // (--remote returns before device checks and never reaches here.)
  if (process.platform !== 'darwin' || isActiveProviderDevice(device)) return;
  emitRequestProgress({
    type: 'command',
    status: 'progress',
    message: `Checking iOS runner build cache (${device.name})...`,
  });
  if (await hasCachedAppleRunnerArtifact(device)) {
    appendDoctorCheck(checks, {
      id: 'ios-runner-cache',
      status: 'pass',
      summary: 'iOS runner artifact cached; first open skips the runner build',
    });
    return;
  }
  void prewarmAppleRunnerCache(device, {});
  emitRequestProgress({
    type: 'command',
    status: 'progress',
    message: `Warming iOS runner build cache in the background (${device.name})...`,
  });
  appendDoctorCheck(checks, {
    id: 'ios-runner-cache',
    status: 'pass',
    summary:
      'iOS runner build started in the background; the first open gets faster once it completes',
    hint: 'Run `agent-device prepare ios-runner` to wait for a fully warmed runner instead.',
  });
}

function resolveDoctorStateDir(sessionStore: SessionStore, sessionName: string): string {
  const sessionsDir = path.dirname(sessionStore.resolveSessionDir(sessionName));
  return path.basename(sessionsDir) === 'sessions' ? path.dirname(sessionsDir) : sessionsDir;
}

async function appendLocalDoctorChecks(params: {
  androidAdbExecutor?: AndroidAdbExecutor;
  checks: DoctorCheck[];
  inventory: DoctorDeviceInventory | undefined;
  options: DoctorOptions;
  session: SessionState | undefined;
  stateDir: string;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  req: DaemonRequest;
}): Promise<DeviceInfo | undefined> {
  const {
    checks,
    inventory,
    options,
    session,
    androidAdbExecutor,
    stateDir,
    inspectFacts,
    bindDevice,
    req,
  } = params;
  const appCheckDevice =
    session?.device ?? resolveDoctorDeviceForAppCheck(checks, inventory, options.targetApp);
  if (appCheckDevice) {
    await appendDeviceScopedDoctorChecks(checks, {
      androidAdbExecutor,
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
  await appendWebBrowserLifecycleCheck(checks, stateDir);
  return appCheckDevice;
}

async function appendDeviceScopedDoctorChecks(
  checks: DoctorCheck[],
  params: {
    androidAdbExecutor?: AndroidAdbExecutor;
    device: DeviceInfo;
    options: DoctorOptions;
    session: SessionState | undefined;
    inspectFacts?: InspectDeviceRuntimeFacts;
    bindDevice?: BindDeviceRuntime;
    req: DaemonRequest;
  },
): Promise<void> {
  const { androidAdbExecutor, device, options, session, inspectFacts, bindDevice, req } = params;
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
  await appendAndroidChecks(checks, {
    androidAdbExecutor,
    device,
    metroPort: options.metroPort,
    shouldProbeMetro: options.shouldProbeMetro,
  });
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
