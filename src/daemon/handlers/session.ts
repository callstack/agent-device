import { dispatchCommand } from '../../core/dispatch.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { contextFromFlags } from '../context.ts';
import { handleReleaseMaterializedPathsCommand } from './session-app-source-deployment.ts';
import { requireSessionOrExplicitSelector, resolveCommandDevice } from './session-device-utils.ts';
import { errorResponse, requireCommandSupported } from './response.ts';
import { recordSessionAction } from './handler-utils.ts';
import { handleRuntimeCommand } from './session-runtime-command.ts';
import { requireRuntimeBinding, requireRuntimeFacts } from './session-runtime-admission.ts';
import { handleOpenCommand } from './session-open.ts';
import { composeOpenWithInitialSnapshot } from './session-open-foreground.ts';
import {
  resolveAndroidPackageForOpen,
  resolveSessionAppBundleIdForTarget,
} from '../../platform-runtime-open-target.ts';
import { handleCloseCommand } from './session-close.ts';
import { handleSessionAppDeploymentCommand } from './session-app-deployment-route.ts';
import { runBatchCommands } from './session-batch.ts';
import { handleSessionInventoryCommands } from './session-inventory.ts';
import { handleSessionStateCommands } from './session-state.ts';
import { handleSessionObservabilityCommands } from './session-observability.ts';
import { handleSessionReplayCommands } from './session-replay.ts';
import { handleSessionScriptPublication } from './session-script-publication.ts';
import { handleDoctorCommand } from './session-doctor.ts';
import { handlePrepareCommand } from './session-prepare.ts';
import { resolveRefFrameEffect } from '../daemon-command-registry.ts';
import type { DescriptorSessionRouteCommandName } from '../../core/command-descriptor/registry.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import type { LeaseLifecycleProvider } from '@agent-device/contracts/device';
import type {
  BindDeviceRuntime,
  BindExactDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../request-runtime-binding.ts';
import type { DeviceClaimReconciler } from '../device-claims.ts';
import type { AppLogAdmissionLedger } from '../app-log-admission-ledger.ts';
import type { ScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';
import type { PlatformRequestScope } from '@agent-device/contracts/platform';

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

export type SessionCommandInput = {
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
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindExactDevice?: BindExactDeviceRuntime;
  appLogAdmissionLedger?: AppLogAdmissionLedger;
  screenRecordingAdmissionLedger?: ScreenRecordingAdmissionLedger;
  requestScope?: PlatformRequestScope;
  retainDeviceExecutionLock?: (deviceId: string) => Promise<void>;
  throwIfCanceled?: () => void;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
};

type SessionCommandParams = Omit<SessionCommandInput, 'leaseRegistry'> & {
  leaseRegistry: LeaseRegistry;
};

type SessionCommandHandler = (params: SessionCommandParams) => Promise<DaemonResponse | null>;

const handleSessionInventoryCommandGroup: SessionCommandHandler = async ({
  req,
  sessionName,
  sessionStore,
  inspectFacts,
  bindDevice,
}) =>
  await handleSessionInventoryCommands({
    req,
    sessionName,
    sessionStore,
    inspectFacts,
    bindDevice,
  });

const handleSessionStateCommandGroup: SessionCommandHandler = async ({
  req,
  sessionName,
  sessionStore,
  inspectFacts,
  bindDevice,
}) =>
  await handleSessionStateCommands({
    req,
    sessionName,
    sessionStore,
    inspectFacts,
    bindDevice,
  });

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
  bindDevice,
  inspectFacts,
  bindExactDevice,
  screenRecordingAdmissionLedger,
  requestScope,
  retainDeviceExecutionLock,
  throwIfCanceled,
}) =>
  await handleSessionReplayCommands({
    req,
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
    invoke: invokeReplayAction ?? invoke,
    bindDevice,
    inspectFacts,
    bindExactDevice,
    screenRecordingAdmissionLedger,
    requestScope,
    retainDeviceExecutionLock,
    throwIfCanceled,
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
  doctor: async ({
    req,
    sessionName,
    sessionStore,
    androidAdbExecutor,
    inspectFacts,
    bindDevice,
  }) =>
    await handleDoctorCommand({
      req,
      sessionName,
      sessionStore,
      androidAdbExecutor,
      inspectFacts,
      bindDevice,
    }),
  boot: handleSessionStateCommandGroup,
  shutdown: handleSessionStateCommandGroup,
  appstate: handleSessionStateCommandGroup,
  session_save_script: async ({ req, sessionName, sessionStore }) =>
    handleSessionScriptPublication({ req, sessionName, sessionStore }),
  runtime: async ({ req, sessionName, sessionStore, inspectFacts, bindDevice }) =>
    await handleRuntimeCommand({
      req,
      sessionName,
      sessionStore,
      inspectFacts,
      bindDevice,
    }),
  clipboard: async ({ req, sessionName, logPath, sessionStore }) =>
    await handleClipboardCommand({ req, sessionName, logPath, sessionStore }),
  keyboard: handleKeyboardCommand,
  perf: handleSessionObservabilityCommandGroup,
  logs: handleSessionObservabilityCommandGroup,
  events: handleSessionObservabilityCommandGroup,
  network: handleSessionObservabilityCommandGroup,
  audio: handleSessionObservabilityCommandGroup,
  prepare: async ({ req, sessionName, logPath, sessionStore, inspectFacts, bindDevice }) =>
    await handlePrepareCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
    }),
  install: handleSessionAppDeploymentCommand,
  reinstall: handleSessionAppDeploymentCommand,
  install_source: handleSessionAppDeploymentCommand,
  release_materialized_paths: async ({ req }) =>
    await handleReleaseMaterializedPathsCommand({ req }),
  push: handleSessionAppDeploymentCommand,
  'trigger-app-event': handleTriggerAppEventCommand,
  open: async ({
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    reconcileOrphanedDeviceClaim,
  }) => {
    const openResponse = await handleOpenCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
      reconcileOrphanedDeviceClaim,
    });
    if (!openResponse.ok || req.flags?.foreground !== true) return openResponse;
    return await composeOpenWithInitialSnapshot({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts: requireRuntimeFacts(inspectFacts),
      bindDevice: requireRuntimeBinding(bindDevice),
      openResponse,
    });
  },
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
    inspectFacts,
    bindDevice,
  }) =>
    await handleCloseCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
      leaseRegistry,
      leaseLifecycleProvider,
      inspectFacts,
      bindDevice,
    }),
} satisfies Record<DescriptorSessionRouteCommandName, SessionCommandHandler>;

export async function handleSessionCommands(
  params: SessionCommandInput,
): Promise<DaemonResponse | null> {
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
    inspectFacts,
    bindDevice,
    bindExactDevice,
    appLogAdmissionLedger,
    screenRecordingAdmissionLedger,
    requestScope,
    retainDeviceExecutionLock,
    throwIfCanceled,
    reconcileOrphanedDeviceClaim,
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
    inspectFacts,
    bindDevice,
    bindExactDevice,
    appLogAdmissionLedger,
    screenRecordingAdmissionLedger,
    requestScope,
    retainDeviceExecutionLock,
    throwIfCanceled,
    reconcileOrphanedDeviceClaim,
  });
}
