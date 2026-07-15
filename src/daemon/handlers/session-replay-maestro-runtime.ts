import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '../../kernel/errors.ts';
import {
  dispatchGestureViewport,
  resolveTargetDevice,
  type CommandFlags,
} from '../../core/dispatch.ts';
import { getRequestSignal } from '../../request/cancel.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import {
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
} from '../../replay/vars.ts';
import { createDaemonMaestroRuntimePort } from '../../compat/maestro/daemon-runtime-port.ts';
import { executeMaestroPlan } from '../../compat/maestro/engine.ts';
import { parseMaestroProgram } from '../../compat/maestro/program-ir-parser.ts';
import { createMaestroProgramLoader } from '../../compat/maestro/program-loader.ts';
import {
  compileMaestroReplayPlan,
  resolveMaestroReplayStartIndex,
} from '../../compat/maestro/replay-plan.ts';
import type { MaestroPlatform, MaestroProgram } from '../../compat/maestro/program-ir.ts';
import type { MaestroReplayPlan } from '../../compat/maestro/replay-plan-types.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';
import { assertSessionSelectorMatches } from '../session-selector.ts';
import { SessionStore } from '../session-store.ts';
import { errorResponse } from './response.ts';
import { buildReplayBuiltinVars } from './session-replay-vars.ts';
import type { MaestroFailedEngineEvent } from './session-replay-maestro-failure.ts';
import { createMaestroReplayObserver } from './session-replay-maestro-observer.ts';
import {
  buildTypedMaestroReplayErrorResponse,
  buildTypedMaestroSuccessResponse,
} from './session-replay-maestro-response.ts';
import { resolveEffectiveOpenRuntimeHints } from './session-runtime.ts';
import { contextFromFlags } from '../context.ts';

type TypedMaestroReplayParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  tracePath?: string;
  invoke: DaemonInvokeFn;
};

type TypedMaestroReplayState = {
  failedEvent?: MaestroFailedEngineEvent;
  plan?: MaestroReplayPlan;
  snapshotStart: number;
};

type TypedMaestroReplayContext = {
  filePath: string;
  program: MaestroProgram;
  device?: DeviceInfo;
  platform: Extract<MaestroPlatform, 'android' | 'ios'>;
  target: string;
  runtimeHints: ReturnType<typeof resolveEffectiveOpenRuntimeHints>;
  defaults: Record<string, string>;
  env: Record<string, string>;
  signal: AbortSignal | undefined;
  loadProgram: ReturnType<typeof createMaestroProgramLoader>;
};

type MaestroReplayBinding = Pick<
  TypedMaestroReplayContext,
  'device' | 'platform' | 'target' | 'runtimeHints'
>;

export async function runTypedMaestroReplayFile(
  params: TypedMaestroReplayParams,
): Promise<DaemonResponse> {
  const { req } = params;
  const requestedPath = req.positionals?.[0];
  if (!requestedPath) return errorResponse('INVALID_ARGS', 'replay requires a path');
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
      ...params,
      requestedPath,
      startedAt,
      state,
    });
  } catch (error) {
    return await buildTypedMaestroReplayErrorResponse({
      ...params,
      requestedPath,
      state,
      error,
    });
  }
}

async function executeTypedMaestroReplay(
  params: TypedMaestroReplayParams & {
    requestedPath: string;
    startedAt: number;
    state: TypedMaestroReplayState;
  },
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore, tracePath, invoke, state } = params;
  const context = await prepareTypedMaestroReplay(params);
  const plan = await compileMaestroReplayPlan(context.program, {
    defaults: context.defaults,
    env: context.env,
    platform: context.platform,
    target: context.target,
    runtimeHints: context.runtimeHints,
    loadProgram: context.loadProgram,
    signal: context.signal,
  });
  state.plan = plan;
  const startIndex = resolveMaestroReplayStartIndex(plan, {
    from: req.flags?.replayFrom,
    planDigest: req.flags?.replayPlanDigest,
  });
  const port = createMaestroReplayPort({
    req,
    invoke,
    logPath: params.logPath,
    sessionName,
    sessionStore,
    device: context.device,
    platform: context.platform,
    runtimeHints: context.runtimeHints,
    sourcePath: context.filePath,
  });
  state.snapshotStart = sessionStore.get(sessionName)?.snapshotDiagnostics?.samples.length ?? 0;
  const result = await executeMaestroPlan(plan, port, {
    defaults: context.defaults,
    env: context.env,
    platform: context.platform,
    target: context.target,
    loadProgram: context.loadProgram,
    signal: context.signal,
    startIndex,
    observer: createMaestroReplayObserver({
      filePath: context.filePath,
      tracePath,
      onFailure: (event) => {
        state.failedEvent = event;
      },
    }),
  });
  return buildTypedMaestroSuccessResponse({
    result,
    plan,
    startIndex,
    startedAt: params.startedAt,
    sessionName,
    sessionStore,
    snapshotStart: state.snapshotStart,
  });
}

async function prepareTypedMaestroReplay(
  params: TypedMaestroReplayParams & { requestedPath: string },
): Promise<TypedMaestroReplayContext> {
  const { req, requestedPath, sessionName, sessionStore } = params;
  const filePath = SessionStore.expandHome(requestedPath, req.meta?.cwd);
  const program = parseMaestroProgram(fs.readFileSync(filePath, 'utf8'), {
    sourcePath: filePath,
  });
  const session = sessionStore.get(sessionName);
  if (session) assertSessionSelectorMatches(session, req.flags);
  const binding = await resolveMaestroReplayBinding({ req, sessionStore, sessionName, session });
  return {
    filePath,
    program,
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
    loadProgram: createMaestroProgramLoader(path.dirname(filePath)),
  };
}

async function resolveMaestroReplayBinding(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  sessionName: string;
  session: ReturnType<SessionStore['get']>;
}): Promise<MaestroReplayBinding> {
  const { req, sessionStore, sessionName, session } = params;
  const requestedPlatform = req.flags?.platform;
  const device =
    session?.device ??
    (requestedPlatform === 'android' || requestedPlatform === 'ios'
      ? undefined
      : await resolveTargetDevice(req.flags ?? {}));
  const platform = resolveMaestroPlatform(req, device);
  const runtimeHints = resolveEffectiveOpenRuntimeHints({
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
  });
}

async function completeMaestroRuntimeBinding(
  params: {
    req: DaemonRequest;
    sessionStore: SessionStore;
    sessionName: string;
  } & MaestroReplayBinding,
): Promise<MaestroReplayBinding> {
  if (params.device || !requiresDeviceRuntimeDefaults(params.runtimeHints)) return params;
  const device = await resolveTargetDevice(params.req.flags ?? {});
  return {
    device,
    platform: params.platform,
    target: resolveMaestroTarget(params.req, device),
    runtimeHints: resolveEffectiveOpenRuntimeHints({
      req: params.req,
      sessionStore: params.sessionStore,
      sessionName: params.sessionName,
      device,
      platform: params.platform,
    }),
  };
}

function requiresDeviceRuntimeDefaults(
  runtimeHints: ReturnType<typeof resolveEffectiveOpenRuntimeHints>,
): boolean {
  return (
    runtimeHints?.metroPort !== undefined &&
    runtimeHints.metroHost === undefined &&
    runtimeHints.bundleUrl === undefined
  );
}

function buildTypedMaestroDefaults(params: {
  req: DaemonRequest;
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

function buildTypedMaestroEnv(req: DaemonRequest): Record<string, string> {
  return {
    ...collectReplayShellEnv(readReplayShellEnvSource(req.flags?.replayShellEnv)),
    ...parseReplayCliEnvEntries(readReplayCliEnvEntries(req.flags?.replayEnv)),
  };
}

function createMaestroReplayPort(params: {
  req: DaemonRequest;
  invoke: DaemonInvokeFn;
  logPath: string;
  sessionName: string;
  sessionStore: SessionStore;
  device: DeviceInfo | undefined;
  platform: Extract<MaestroPlatform, 'android' | 'ios'>;
  runtimeHints: ReturnType<typeof resolveEffectiveOpenRuntimeHints>;
  sourcePath: string;
}) {
  const {
    req,
    invoke,
    logPath,
    sessionName,
    sessionStore,
    device,
    platform,
    runtimeHints,
    sourcePath,
  } = params;
  const {
    command: _command,
    positionals: _positionals,
    input: _input,
    flags: _flags,
    ...requestBase
  } = req;
  const baseReq = stripUndefined({
    ...requestBase,
    flags: maestroRuntimeDeviceFlags(device, platform, req.flags),
    runtime: runtimeHints,
  });
  return createDaemonMaestroRuntimePort({
    baseReq,
    invoke,
    platform,
    sourcePath,
    dependencies: {
      now: Date.now,
      sleep: async (milliseconds, abortSignal) => {
        await sleep(milliseconds, undefined, { signal: abortSignal });
      },
      resolveGestureViewport: async () => {
        const session = sessionStore.get(sessionName);
        if (!session) {
          throw new AppError('SESSION_NOT_FOUND', 'No active session. Run open first.');
        }
        return await dispatchGestureViewport(
          session.device,
          contextFromFlags(logPath, req.flags, session.appBundleId, session.trace?.outPath),
        );
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

export function isTypedMaestroReplay(req: DaemonRequest, filePath: string): boolean {
  return (
    req.flags?.replayBackend === 'maestro' &&
    (path.extname(filePath) === '.yaml' || path.extname(filePath) === '.yml')
  );
}

function resolveMaestroPlatform(
  req: DaemonRequest,
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

function resolveMaestroTarget(req: DaemonRequest, sessionDevice: DeviceInfo | undefined): string {
  return typeof req.flags?.target === 'string'
    ? req.flags.target
    : (sessionDevice?.target ?? 'mobile');
}
