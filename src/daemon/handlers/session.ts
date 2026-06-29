import { dispatchCommand } from '../../core/dispatch.ts';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { resolvePayloadInput } from '../../utils/payload-input.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import {
  prepareIosRunner,
  type PrepareIosRunnerResult,
} from '../../platforms/ios/runner-client.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { isApplePlatform } from '../../kernel/device.ts';
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
import { getSessionCommandKind } from '../daemon-command-registry.ts';
import { LeaseRegistry } from '../lease-registry.ts';

const PREPARE_IOS_RUNNER_MIN_STARTUP_TIMEOUT_MS = 45_000;
const PREPARE_IOS_RUNNER_DEFAULT_BUILD_TIMEOUT_MS = 5 * 60_000;
const PREPARE_IOS_RUNNER_HEALTH_TIMEOUT_MS = 90_000;

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
  if (!isApplePlatform(device.platform)) {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      'prepare ios-runner is only supported on Apple runner platforms',
    );
  }

  const startedAtMs = Date.now();
  const result = await prepareIosRunner(
    device,
    buildPrepareIosRunnerOptions(req, session, logPath),
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
): Parameters<typeof prepareIosRunner>[1] {
  const buildTimeoutMs = readPrepareIosRunnerBuildTimeoutMs(req);
  return {
    ...buildAppleRunnerRequestOptions({
      req,
      logPath,
      traceLogPath: session?.trace?.outPath,
    }),
    cleanStaleBundles: true,
    startupTimeoutMs: resolvePrepareIosRunnerStartupTimeoutMs(req.flags?.timeoutMs),
    buildTimeoutMs,
    healthTimeoutMs: Math.min(buildTimeoutMs, PREPARE_IOS_RUNNER_HEALTH_TIMEOUT_MS),
  };
}

function resolvePrepareIosRunnerStartupTimeoutMs(timeoutMs: unknown): number | undefined {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.max(PREPARE_IOS_RUNNER_MIN_STARTUP_TIMEOUT_MS, Math.floor(timeoutMs));
}

function readPrepareIosRunnerBuildTimeoutMs(req: DaemonRequest): number {
  const value = req.flags?.timeoutMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : PREPARE_IOS_RUNNER_DEFAULT_BUILD_TIMEOUT_MS;
}

function prepareIosRunnerResponseData(
  action: string,
  device: DeviceInfo,
  durationMs: number,
  result: PrepareIosRunnerResult,
): Record<string, unknown> {
  return {
    action,
    platform: device.platform,
    deviceId: device.id,
    deviceName: device.name,
    kind: device.kind,
    durationMs,
    ...result,
    message: `Prepared Apple runner: ${device.name}`,
  };
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
  return { ok: true, data: { platform: device.platform, ...(result ?? {}) } };
}

// fallow-ignore-next-line complexity
export async function handleSessionCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry?: LeaseRegistry;
  invoke: DaemonInvokeFn;
  invokeReplayAction?: DaemonInvokeFn;
  androidAdbExecutor?: AndroidAdbExecutor;
}): Promise<DaemonResponse | null> {
  const {
    req,
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry = new LeaseRegistry(),
    invoke,
    invokeReplayAction,
    androidAdbExecutor,
  } = params;

  if (getSessionCommandKind(req.command) === 'inventory') {
    return await handleSessionInventoryCommands({
      req,
      sessionName,
      sessionStore,
    });
  }

  if (req.command === 'runtime') {
    return await handleRuntimeCommand({
      req,
      sessionName,
      sessionStore,
    });
  }

  if (getSessionCommandKind(req.command) === 'state') {
    return await handleSessionStateCommands({
      req,
      sessionName,
      logPath,
      sessionStore,
    });
  }

  if (req.command === PUBLIC_COMMANDS.clipboard) {
    return await handleClipboardCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
    });
  }

  if (req.command === PUBLIC_COMMANDS.keyboard) {
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

  if (getSessionCommandKind(req.command) === 'observability') {
    return await handleSessionObservabilityCommands({
      req,
      sessionName,
      sessionStore,
      androidAdbExecutor,
    });
  }

  if (req.command === PUBLIC_COMMANDS.prepare) {
    return await handlePrepareCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
    });
  }

  if (req.command === PUBLIC_COMMANDS.install || req.command === PUBLIC_COMMANDS.reinstall) {
    return await handleAppDeployCommand({
      req,
      command: req.command,
      sessionName,
      sessionStore,
      deployOps: req.command === PUBLIC_COMMANDS.install ? defaultInstallOps : defaultReinstallOps,
    });
  }

  if (req.command === INTERNAL_COMMANDS.installSource) {
    return await handleInstallFromSourceCommand({
      req,
      sessionName,
      sessionStore,
    });
  }

  if (req.command === INTERNAL_COMMANDS.releaseMaterializedPaths) {
    return await handleReleaseMaterializedPathsCommand({ req });
  }

  if (req.command === PUBLIC_COMMANDS.push) {
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

  if (req.command === PUBLIC_COMMANDS.triggerAppEvent) {
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

  if (req.command === PUBLIC_COMMANDS.open) {
    return await handleOpenCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
    });
  }

  if (getSessionCommandKind(req.command) === 'replay') {
    return await handleSessionReplayCommands({
      req,
      sessionName,
      logPath,
      sessionStore,
      leaseRegistry,
      invoke: invokeReplayAction ?? invoke,
    });
  }

  if (req.command === PUBLIC_COMMANDS.batch) {
    return await runBatchCommands(req, sessionName, invoke);
  }

  if (req.command === PUBLIC_COMMANDS.close) {
    return await handleCloseCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
      leaseRegistry,
    });
  }

  return null;
}

function maybeResolvePushPayloadPath(payloadArg: string, cwd?: string): string {
  const resolved = resolvePayloadInput(payloadArg, {
    subject: 'Push payload',
    cwd,
    expandPath: (value, currentCwd) => SessionStore.expandHome(value, currentCwd),
  });
  return resolved.kind === 'file' ? resolved.path : resolved.text;
}
