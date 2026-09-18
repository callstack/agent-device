import type { CommandFlags, DaemonWireRequest } from '@agent-device/contracts/command';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  executeMaestroFlow,
  inspectMaestroFlow,
  type MaestroFlow,
  type MaestroPlatform,
} from '@agent-device/maestro';
import { AppError } from '@agent-device/kernel/errors';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import { getRequestSignal } from '@agent-device/host-kit/request';
import {
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
} from '@agent-device/ad-script';
import { createDaemonMaestroRuntimePort } from '@agent-device/maestro/daemon-runtime-port';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { buildReplayBuiltinVars } from './session-replay-vars.ts';
import { createMaestroReplayObserver } from './session-replay-maestro-observer.ts';
import { maestroOperationDispatchRequest } from './session-replay-maestro-request.ts';
import {
  buildTypedMaestroReplayErrorResponse,
  buildTypedMaestroSuccessResponse,
} from './session-replay-maestro-response.ts';
import { buildMaestroReplayTargetDeviceResolutionOptions } from './replay-script-selection.ts';
import {
  readReplayScriptSourceFile,
  REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE,
} from '../../replay-script-source.ts';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import type { ReplayCommand, ReplayDispatchRequest, ReplaySessionStore } from './command-types.ts';
import {
  errorResponse,
  type DaemonResponse,
  type SessionRuntimeHints,
} from '@agent-device/kernel/contracts';

type TypedMaestroReplayState = {
  snapshotStart: number;
};

type TypedMaestroReplayPreparation = Readonly<{
  command: ReplayCommand;
  bundle: ReplayScriptSourceBundle;
}>;

type TypedMaestroReplayExecution = TypedMaestroReplayPreparation &
  Readonly<{
    startedAt: number;
    state: TypedMaestroReplayState;
  }>;

type TypedMaestroReplayContext = {
  filePath: string;
  flow: MaestroFlow;
  device?: DeviceInfo;
  platform: Extract<MaestroPlatform, 'android' | 'ios'>;
  target: string;
  runtimeHints: SessionRuntimeHints | undefined;
  defaults: Record<string, string>;
  env: Record<string, string>;
  signal: AbortSignal | undefined;
};

type MaestroReplayBinding = Pick<
  TypedMaestroReplayContext,
  'device' | 'platform' | 'target' | 'runtimeHints'
>;

export async function runTypedMaestroReplay(command: ReplayCommand): Promise<DaemonResponse> {
  const { request: req } = command;
  const bundle = req.flags?.replayScriptSource;
  if (!bundle) return errorResponse('INVALID_ARGS', REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE);
  if (req.flags?.saveScript !== undefined) {
    return errorResponse(
      'INVALID_ARGS',
      'Maestro YAML does not support --save-script; ADR 0012 repair recording applies only to .ad scripts.',
    );
  }
  const startedAt = Date.now();
  const state: TypedMaestroReplayState = { snapshotStart: 0 };
  try {
    return await executeTypedMaestroReplay({
      command,
      bundle,
      startedAt,
      state,
    });
  } catch (error) {
    return await buildTypedMaestroReplayErrorResponse({
      command,
      replayPath: bundle.entry,
      state,
      outcome: { ok: false, error },
    });
  }
}

async function executeTypedMaestroReplay(
  params: TypedMaestroReplayExecution,
): Promise<DaemonResponse> {
  const { command, bundle, startedAt, state } = params;
  const {
    request: req,
    session: { store: sessionStore },
    tracePath,
    onStep,
  } = command;
  const context = await prepareTypedMaestroReplay({ command, bundle });
  // evalScript runs via node:vm, which is not a security sandbox; only trust it
  // for flows that did not arrive over the daemon's remote HTTP surface.
  const publicNetworkOnly = command.publicNetworkOnly === true;
  const port = createMaestroReplayPort({
    command,
    device: context.device,
    platform: context.platform,
    runtimeHints: context.runtimeHints,
    sourcePath: context.filePath,
    publicNetworkOnly,
  });
  state.snapshotStart = sessionStore.get()?.snapshotDiagnostics?.samples.length ?? 0;
  const outcome = await executeMaestroFlow(context.flow, port, {
    defaults: context.defaults,
    env: context.env,
    platform: context.platform,
    target: context.target,
    runtimeHints: context.runtimeHints,
    signal: context.signal,
    from: req.flags?.replayFrom,
    planDigest: req.flags?.replayPlanDigest,
    trustedScripts: !publicNetworkOnly,
    // #1802: `runFlow` includes resolve out of the caller's bundle, so a local
    // and a remote run compile the same flow closure.
    readSource: (includePath) => readReplayScriptSourceFile(bundle, includePath),
    observer: createMaestroReplayObserver({
      filePath: context.filePath,
      tracePath,
      onStep,
    }),
  });
  if (!outcome.ok) {
    return await buildTypedMaestroReplayErrorResponse({
      command,
      replayPath: bundle.entry,
      state,
      outcome,
    });
  }
  return buildTypedMaestroSuccessResponse({
    outcome,
    command,
    startedAt,
    snapshotStart: state.snapshotStart,
  });
}

async function prepareTypedMaestroReplay(
  params: TypedMaestroReplayPreparation,
): Promise<TypedMaestroReplayContext> {
  const { command, bundle } = params;
  const {
    request: req,
    session: { name: sessionName, store: sessionStore },
  } = command;
  const filePath = bundle.entry;
  const flow = inspectMaestroFlow(readReplayScriptSourceFile(bundle, filePath), filePath);
  // `sessionName` is the resolved store key, so the lookup carries the address a selector
  // conflict must tell the caller to close or reuse.
  const sessionRef = sessionStore.lookup();
  const session = sessionRef?.session;
  if (sessionRef) sessionStore.assertSelectorMatches(req.flags);
  const binding = await resolveMaestroReplayBinding({
    req,
    sessionStore,
    sessionName,
    session,
    flow,
  });
  return {
    filePath,
    flow,
    ...binding,
    defaults: buildTypedMaestroDefaults({
      req,
      sessionName,
      filePath,
      platform: binding.platform,
      target: binding.target,
    }),
    env: buildTypedMaestroEnv(req),
    signal: getRequestSignal(req.meta?.requestId),
  };
}

async function resolveMaestroReplayBinding(params: {
  req: DaemonWireRequest;
  sessionStore: ReplaySessionStore;
  sessionName: string;
  session: ReturnType<ReplaySessionStore['get']>;
  flow: MaestroFlow;
}): Promise<MaestroReplayBinding> {
  const { req, sessionStore, sessionName, session, flow } = params;
  const requestedPlatform = req.flags?.platform;
  const device =
    session?.device ??
    (requestedPlatform === 'android' || requestedPlatform === 'ios'
      ? undefined
      : await resolveTargetDevice(
          req.flags ?? {},
          buildMaestroReplayTargetDeviceResolutionOptions(flow.appTarget, requestedPlatform),
        ));
  const platform = resolveMaestroPlatform(req, device);
  const runtimeHints = resolveReplayRuntimeHints({
    req,
    sessionStore,
    sessionName,
    device,
    platform,
  });
  return await completeMaestroRuntimeBinding({
    req,
    sessionStore,
    sessionName,
    device,
    platform,
    target: resolveMaestroTarget(req, device),
    runtimeHints,
    flow,
  });
}

async function completeMaestroRuntimeBinding(
  params: {
    req: DaemonWireRequest;
    sessionStore: ReplaySessionStore;
    sessionName: string;
    flow: MaestroFlow;
  } & MaestroReplayBinding,
): Promise<MaestroReplayBinding> {
  if (params.device || !requiresDeviceRuntimeDefaults(params.runtimeHints)) return params;
  const device = await resolveTargetDevice(
    params.req.flags ?? {},
    buildMaestroReplayTargetDeviceResolutionOptions(params.flow.appTarget, params.platform),
  );
  return {
    device,
    platform: params.platform,
    target: resolveMaestroTarget(params.req, device),
    runtimeHints: resolveReplayRuntimeHints({
      req: params.req,
      sessionStore: params.sessionStore,
      sessionName: params.sessionName,
      device,
      platform: params.platform,
    }),
  };
}

function resolveReplayRuntimeHints(params: {
  req: DaemonWireRequest;
  sessionStore: ReplaySessionStore;
  sessionName: string;
  device?: DeviceInfo;
  platform?: Extract<MaestroPlatform, 'android' | 'ios'>;
}): SessionRuntimeHints | undefined {
  return params.sessionStore.resolveOpenRuntimeHints({
    request: params.req,
    device: params.device,
    platform: params.platform,
  });
}

function requiresDeviceRuntimeDefaults(runtimeHints: SessionRuntimeHints | undefined): boolean {
  return (
    runtimeHints?.metroPort !== undefined &&
    runtimeHints.metroHost === undefined &&
    runtimeHints.bundleUrl === undefined
  );
}

function buildTypedMaestroDefaults(params: {
  req: DaemonWireRequest;
  sessionName: string;
  filePath: string;
  platform: Extract<MaestroPlatform, 'android' | 'ios'>;
  target: string;
}): Record<string, string> {
  return {
    ...buildReplayBuiltinVars({
      req: params.req,
      sessionName: params.sessionName,
      metadata: {},
      resolvedPath: params.filePath,
    }),
    AD_PLATFORM: params.platform,
    AD_TARGET: params.target,
  };
}

function buildTypedMaestroEnv(req: DaemonWireRequest): Record<string, string> {
  return {
    ...collectReplayShellEnv(readReplayShellEnvSource(req.flags?.replayShellEnv)),
    ...parseReplayCliEnvEntries(readReplayCliEnvEntries(req.flags?.replayEnv)),
  };
}

function createMaestroReplayPort(params: {
  command: ReplayCommand;
  device: DeviceInfo | undefined;
  platform: Extract<MaestroPlatform, 'android' | 'ios'>;
  runtimeHints: SessionRuntimeHints | undefined;
  sourcePath: string;
  publicNetworkOnly: boolean;
}) {
  const { command, device, platform, runtimeHints, sourcePath, publicNetworkOnly } = params;
  const { request: req, invoke } = command;
  const replay: ReplayDispatchRequest = {
    ...req,
    runtime: runtimeHints,
    ...(command.dispatch ? { dispatch: command.dispatch } : {}),
  };
  return createDaemonMaestroRuntimePort({
    invoke: (operation) => invoke(maestroOperationDispatchRequest(replay, operation)),
    flags: maestroRuntimeDeviceFlags(device, platform, req.flags),
    publicNetworkOnly,
    platform,
    sourcePath,
    dependencies: {
      now: Date.now,
      sleep: async (milliseconds, abortSignal) => {
        await sleep(milliseconds, undefined, { signal: abortSignal });
      },
    },
  });
}

function maestroRuntimeDeviceFlags(
  device: DeviceInfo | undefined,
  platform: Extract<MaestroPlatform, 'android' | 'ios'>,
  requestedFlags: CommandFlags | undefined,
): CommandFlags {
  if (!device) return unresolvedMaestroRuntimeDeviceFlags(platform, requestedFlags);
  const flags: CommandFlags = {
    platform,
    target: device.target,
    noRecord: true,
  };
  if (platform === 'android') return { ...flags, serial: device.id };
  return {
    ...flags,
    udid: device.id,
    ...(device.simulatorSetPath ? { iosSimulatorDeviceSet: device.simulatorSetPath } : {}),
  };
}

function unresolvedMaestroRuntimeDeviceFlags(
  platform: Extract<MaestroPlatform, 'android' | 'ios'>,
  requestedFlags: CommandFlags | undefined,
): CommandFlags {
  const flags: CommandFlags = {
    platform,
    target: requestedFlags?.target ?? 'mobile',
    noRecord: true,
  };
  if (requestedFlags?.device) flags.device = requestedFlags.device;
  return platform === 'android'
    ? unresolvedAndroidMaestroFlags(flags, requestedFlags)
    : unresolvedIosMaestroFlags(flags, requestedFlags);
}

function unresolvedAndroidMaestroFlags(
  flags: CommandFlags,
  requestedFlags: CommandFlags | undefined,
): CommandFlags {
  if (requestedFlags?.serial) flags.serial = requestedFlags.serial;
  if (requestedFlags?.androidDeviceAllowlist) {
    flags.androidDeviceAllowlist = requestedFlags.androidDeviceAllowlist;
  }
  return flags;
}

function unresolvedIosMaestroFlags(
  flags: CommandFlags,
  requestedFlags: CommandFlags | undefined,
): CommandFlags {
  if (requestedFlags?.udid) flags.udid = requestedFlags.udid;
  if (requestedFlags?.iosSimulatorDeviceSet) {
    flags.iosSimulatorDeviceSet = requestedFlags.iosSimulatorDeviceSet;
  }
  return flags;
}

function resolveMaestroPlatform(
  req: DaemonWireRequest,
  sessionDevice: DeviceInfo | undefined,
): Extract<MaestroPlatform, 'android' | 'ios'> {
  const platform = req.flags?.platform;
  if (platform === 'android' || platform === 'ios') return platform;
  if (sessionDevice?.platform === 'android') return 'android';
  if (sessionDevice?.platform === 'apple' && sessionDevice.appleOs === 'ios') return 'ios';
  throw new AppError(
    'INVALID_ARGS',
    'Maestro replay requires --platform android|ios or an active mobile session.',
  );
}

function resolveMaestroTarget(
  req: DaemonWireRequest,
  sessionDevice: DeviceInfo | undefined,
): string {
  return typeof req.flags?.target === 'string'
    ? req.flags.target
    : (sessionDevice?.target ?? 'mobile');
}
