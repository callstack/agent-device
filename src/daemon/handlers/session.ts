import { dispatchCommand } from '../../core/dispatch.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { resolvePayloadInput } from '../../utils/payload-input.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import {
  prepareIosRunner,
  type PrepareIosRunnerResult,
} from '../../platforms/apple/core/runner/runner-client.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { publicPlatformString } from '@agent-device/kernel/device';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { contextFromFlags } from '../context.ts';
import { buildAppleRunnerRequestOptions } from '../apple-runner-options.ts';
import {
  handleInstallFromSourceCommand,
  handleReleaseMaterializedPathsCommand,
} from './install-source.ts';
import { requireSessionOrExplicitSelector, resolveCommandDevice } from './session-device-utils.ts';
import { errorResponse, requireCommandSupported } from './response.ts';
import { recordSessionAction } from './handler-utils.ts';
import { handleRuntimeCommand } from './session-runtime-command.ts';
import { handleOpenCommand } from './session-open.ts';
import { composeOpenWithInitialSnapshot } from './session-open-foreground.ts';
import {
  resolveAndroidPackageForOpen,
  resolveSessionAppBundleIdForTarget,
} from './session-open-target.ts';
import { handleCloseCommand } from './session-close.ts';
import {
  defaultInstallOps,
  defaultReinstallOps,
  handleAppDeployCommand,
} from './session-deploy.ts';
import { runBatchCommands } from './session-batch.ts';
import { handleSessionInventoryCommands } from './session-inventory.ts';
import { handleSessionStateCommands } from './session-state.ts';
import { handleSessionObservabilityCommands } from './session-observability.ts';
import { handleSessionReplayCommands } from './session-replay.ts';
import { handleSessionScriptPublication } from './session-script-publication.ts';
import { handleDoctorCommand } from './session-doctor.ts';
import { resolveRefFrameEffect } from '../daemon-command-registry.ts';
import type { DescriptorSessionRouteCommandName } from '../../core/command-descriptor/registry.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { PREPARE_REQUEST_TIMEOUT_MS } from '../../core/command-descriptor/timeout-policy.ts';
import { Deadline } from '../../utils/retry.ts';
import type { LeaseLifecycleProvider } from '@agent-device/contracts/device';
import type { BindDeviceRuntime } from '../request-runtime-binding.ts';
import type { AppLogAdmissionLedger } from '../app-log-admission-ledger.ts';

const PREPARE_IOS_RUNNER_TIMING_NOTE =
  'Top-level prepare timing fields are diagnostic and may overlap; use timing.additiveParts for additive wall-clock phases.';

async function handlePrepareCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
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

  const device = await resolveCommandDevice({
    session,
    flags,
    ensureReady: true,
  });
  const unsupported = requireCommandSupported(PUBLIC_COMMANDS.prepare, device);
  if (unsupported) return unsupported;

  const startedAtMs = Date.now();
  const result = await prepareIosRunner(
    device,
    buildPrepareIosRunnerOptions(req, session, logPath, startedAtMs),
  );
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  return {
    ok: true,
    data: prepareIosRunnerResponseData(action, device, durationMs, result),
  };
}

function buildPrepareIosRunnerOptions(
  req: DaemonRequest,
  session: SessionState | undefined,
  logPath: string,
  startedAtMs: number,
): Parameters<typeof prepareIosRunner>[1] {
  const timeoutMs = readPrepareIosRunnerTimeoutMs(req);
  return {
    ...buildAppleRunnerRequestOptions({
      req,
      logPath,
      traceLogPath: session?.trace?.outPath,
    }),
    cleanStaleBundles: true,
    buildTimeoutMs: timeoutMs,
    healthTimeoutMs: timeoutMs,
    prepareDeadline: Deadline.fromTimeoutMs(timeoutMs, startedAtMs),
    startupTimeoutMs: timeoutMs,
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
  result: PrepareIosRunnerResult,
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
  result: PrepareIosRunnerResult,
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

// fallow-ignore-next-line complexity
async function runSessionOrSelectorDispatch(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  command: string;
  positionals: string[];
  recordPositionals?: string[];
  deriveNextSession?: (
    session: SessionState,
    result: Record<string, unknown> | void,
    device: DeviceInfo,
  ) => Promise<SessionState> | SessionState;
}): Promise<DaemonResponse> {
  const {
    req,
    sessionName,
    logPath,
    sessionStore,
    command,
    positionals,
    recordPositionals,
    deriveNextSession,
  } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const guard = requireSessionOrExplicitSelector(command, session, flags);
  if (guard) return guard;

  const device = await resolveCommandDevice({
    session,
    flags,
    ensureReady: true,
  });
  const unsupported = requireCommandSupported(command, device);
  if (unsupported) return unsupported;

  // ADR 0014 side-effect seam for session/selector-route leaves (keyboard
  // dismiss/enter/return, push, trigger-app-event). Expire the frame before the
  // dispatch when the classification says this request mutates; keyboard
  // status/get resolve to `preserve` and leave the frame untouched.
  if (session && resolveRefFrameEffect(req) === 'may-invalidate') {
    expireRefFrame(session);
  }

  const result = await dispatchCommand(device, command, positionals, req.flags?.out, {
    ...contextFromFlags(logPath, req.flags, session?.appBundleId, session?.trace?.outPath),
  });
  if (session) {
    const nextSession = deriveNextSession
      ? await deriveNextSession(session, result, device)
      : session;
    recordSessionAction(sessionStore, nextSession, req, command, result ?? {}, {
      positionals: recordPositionals ?? positionals,
    });
    if (nextSession !== session) {
      sessionStore.set(sessionName, nextSession);
    }
  }
  return { ok: true, data: result ?? {} };
}

// fallow-ignore-next-line complexity
async function handleClipboardCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const guard = requireSessionOrExplicitSelector(PUBLIC_COMMANDS.clipboard, session, flags);
  if (guard) return guard;

  const action = (req.positionals?.[0] ?? '').toLowerCase();
  if (action !== 'read' && action !== 'write') {
    return errorResponse('INVALID_ARGS', 'clipboard requires a subcommand: read or write');
  }

  const device = await resolveCommandDevice({
    session,
    flags,
    ensureReady: true,
  });
  const unsupported = requireCommandSupported(PUBLIC_COMMANDS.clipboard, device);
  if (unsupported) return unsupported;

  const result = await dispatchCommand(
    device,
    PUBLIC_COMMANDS.clipboard,
    req.positionals ?? [],
    req.flags?.out,
    {
      ...contextFromFlags(logPath, req.flags, session?.appBundleId, session?.trace?.outPath),
    },
  );
  recordSessionAction(sessionStore, session, req, req.command, result ?? {});
  return { ok: true, data: { platform: publicPlatformString(device), ...(result ?? {}) } };
}

type SessionCommandParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  invoke: DaemonInvokeFn;
  invokeReplayAction?: DaemonInvokeFn;
  androidAdbExecutor?: AndroidAdbExecutor;
  bindDevice?: BindDeviceRuntime;
  appLogAdmissionLedger?: AppLogAdmissionLedger;
  throwIfCanceled?: () => void;
};

type SessionCommandHandler = (params: SessionCommandParams) => Promise<DaemonResponse | null>;

const handleSessionInventoryCommandGroup: SessionCommandHandler = async ({
  req,
  sessionName,
  sessionStore,
  bindDevice,
}) => await handleSessionInventoryCommands({ req, sessionName, sessionStore, bindDevice });

const handleSessionStateCommandGroup: SessionCommandHandler = async ({
  req,
  sessionName,
  logPath,
  sessionStore,
}) => await handleSessionStateCommands({ req, sessionName, logPath, sessionStore });

const handleSessionObservabilityCommandGroup: SessionCommandHandler = async ({
  req,
  sessionName,
  sessionStore,
  androidAdbExecutor,
  bindDevice,
  appLogAdmissionLedger,
  throwIfCanceled,
}) =>
  await handleSessionObservabilityCommands({
    req,
    sessionName,
    sessionStore,
    androidAdbExecutor,
    bindDevice,
    appLogAdmissionLedger,
    throwIfCanceled,
  });

const handleSessionReplayCommandGroup: SessionCommandHandler = async ({
  req,
  sessionName,
  logPath,
  sessionStore,
  leaseRegistry,
  invoke,
  invokeReplayAction,
}) =>
  await handleSessionReplayCommands({
    req,
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
    invoke: invokeReplayAction ?? invoke,
  });

async function handleKeyboardCommand(params: SessionCommandParams): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  const keyboardAction = req.positionals?.[0]?.trim().toLowerCase();
  const needsForegroundIosApp =
    keyboardAction === 'dismiss' || keyboardAction === 'enter' || keyboardAction === 'return';
  if (!session && needsForegroundIosApp) {
    const flags = req.flags ?? {};
    const normalizedPlatform = flags.platform;
    if (normalizedPlatform === 'ios') {
      return errorResponse(
        'SESSION_NOT_FOUND',
        'iOS keyboard action requires an active session so the target app stays foregrounded. Run open first.',
      );
    }
  }
  return await runSessionOrSelectorDispatch({
    req,
    sessionName,
    logPath,
    sessionStore,
    command: PUBLIC_COMMANDS.keyboard,
    positionals: req.positionals ?? [],
  });
}

async function handlePushCommand(params: SessionCommandParams): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore } = params;
  const appId = req.positionals?.[0]?.trim();
  const payloadArg = req.positionals?.[1]?.trim();
  if (!appId || !payloadArg) {
    return errorResponse(
      'INVALID_ARGS',
      'push requires <bundle|package> <payload.json|inline-json>',
    );
  }

  return await runSessionOrSelectorDispatch({
    req,
    sessionName,
    logPath,
    sessionStore,
    command: PUBLIC_COMMANDS.push,
    positionals: [appId, maybeResolvePushPayloadPath(payloadArg, req.meta?.cwd)],
    recordPositionals: [appId, payloadArg],
  });
}

async function handleTriggerAppEventCommand(params: SessionCommandParams): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore } = params;
  return await runSessionOrSelectorDispatch({
    req,
    sessionName,
    logPath,
    sessionStore,
    command: PUBLIC_COMMANDS.triggerAppEvent,
    positionals: req.positionals ?? [],
    deriveNextSession: async (session, result) => {
      const eventUrl = typeof result?.eventUrl === 'string' ? result.eventUrl : undefined;
      const nextAppBundleId = eventUrl
        ? ((await resolveSessionAppBundleIdForTarget(
            session.device,
            eventUrl,
            session.appBundleId,
            resolveAndroidPackageForOpen,
          )) ?? session.appBundleId)
        : session.appBundleId;
      return {
        ...session,
        appBundleId: nextAppBundleId,
      };
    },
  });
}

/**
 * Descriptor-driven exhaustive dispatch table for the daemon's `session`
 * route (mirrors `DISPATCH_HANDLERS` in src/core/dispatch.ts and
 * `SNAPSHOT_COMMAND_HANDLER_IMPLS` in src/daemon/handlers/snapshot.ts). The
 * `satisfies Record<DescriptorSessionRouteCommandName, …>` check means a
 * session-routed descriptor added to the registry without a matching entry
 * here is a COMPILE error, not a runtime routing gap. Command-kind groupings
 * (`getSessionCommandKind`'s former inventory/state/observability/replay
 * clusters) map several keys to the SAME handler reference below.
 */
const SESSION_COMMAND_HANDLER_IMPLS = {
  session_list: handleSessionInventoryCommandGroup,
  devices: handleSessionInventoryCommandGroup,
  capabilities: handleSessionInventoryCommandGroup,
  apps: handleSessionInventoryCommandGroup,
  doctor: async ({ req, sessionName, sessionStore, androidAdbExecutor }) =>
    await handleDoctorCommand({ req, sessionName, sessionStore, androidAdbExecutor }),
  boot: handleSessionStateCommandGroup,
  shutdown: handleSessionStateCommandGroup,
  appstate: handleSessionStateCommandGroup,
  session_save_script: async ({ req, sessionName, sessionStore }) =>
    handleSessionScriptPublication({ req, sessionName, sessionStore }),
  runtime: async ({ req, sessionName, sessionStore }) =>
    await handleRuntimeCommand({ req, sessionName, sessionStore }),
  clipboard: async ({ req, sessionName, logPath, sessionStore }) =>
    await handleClipboardCommand({ req, sessionName, logPath, sessionStore }),
  keyboard: handleKeyboardCommand,
  perf: handleSessionObservabilityCommandGroup,
  logs: handleSessionObservabilityCommandGroup,
  events: handleSessionObservabilityCommandGroup,
  network: handleSessionObservabilityCommandGroup,
  audio: handleSessionObservabilityCommandGroup,
  prepare: async ({ req, sessionName, logPath, sessionStore }) =>
    await handlePrepareCommand({ req, sessionName, logPath, sessionStore }),
  install: async ({ req, sessionName, sessionStore }) =>
    await handleAppDeployCommand({
      req,
      command: 'install',
      sessionName,
      sessionStore,
      deployOps: defaultInstallOps,
    }),
  reinstall: async ({ req, sessionName, sessionStore }) =>
    await handleAppDeployCommand({
      req,
      command: 'reinstall',
      sessionName,
      sessionStore,
      deployOps: defaultReinstallOps,
    }),
  install_source: async ({ req, sessionName, sessionStore }) =>
    await handleInstallFromSourceCommand({ req, sessionName, sessionStore }),
  release_materialized_paths: async ({ req }) =>
    await handleReleaseMaterializedPathsCommand({ req }),
  push: handlePushCommand,
  'trigger-app-event': handleTriggerAppEventCommand,
  open: async ({ req, sessionName, logPath, sessionStore }) =>
    await composeOpenWithInitialSnapshot({
      req,
      sessionName,
      logPath,
      sessionStore,
      openResponse: await handleOpenCommand({ req, sessionName, logPath, sessionStore }),
    }),
  replay: handleSessionReplayCommandGroup,
  test: handleSessionReplayCommandGroup,
  batch: async ({ req, sessionName, invoke }) => await runBatchCommands(req, sessionName, invoke),
  close: async ({
    req,
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider,
  }) =>
    await handleCloseCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
      leaseRegistry,
      leaseLifecycleProvider,
    }),
} satisfies Record<DescriptorSessionRouteCommandName, SessionCommandHandler>;

export async function handleSessionCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry?: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  invoke: DaemonInvokeFn;
  invokeReplayAction?: DaemonInvokeFn;
  androidAdbExecutor?: AndroidAdbExecutor;
  bindDevice?: BindDeviceRuntime;
  appLogAdmissionLedger?: AppLogAdmissionLedger;
  throwIfCanceled?: () => void;
}): Promise<DaemonResponse | null> {
  const {
    req,
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry = new LeaseRegistry(),
    leaseLifecycleProvider,
    invoke,
    invokeReplayAction,
    androidAdbExecutor,
    bindDevice,
    appLogAdmissionLedger,
    throwIfCanceled,
  } = params;

  const handler =
    SESSION_COMMAND_HANDLER_IMPLS[req.command as keyof typeof SESSION_COMMAND_HANDLER_IMPLS];
  if (!handler) return null;

  return await handler({
    req,
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider,
    invoke,
    invokeReplayAction,
    androidAdbExecutor,
    bindDevice,
    appLogAdmissionLedger,
    throwIfCanceled,
  });
}

function maybeResolvePushPayloadPath(payloadArg: string, cwd?: string): string {
  const resolved = resolvePayloadInput(payloadArg, {
    subject: 'Push payload',
    cwd,
    expandPath: (value, currentCwd) => SessionStore.expandHome(value, currentCwd),
  });
  return resolved.kind === 'file' ? resolved.path : resolved.text;
}
