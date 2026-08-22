import { dispatchCommand } from '../../core/dispatch.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import { publicPlatformString } from '@agent-device/kernel/device';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';
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
  handleKeyboardCommand,
  handleTriggerAppEventCommand,
} from './session-selector-dispatch.ts';
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
import type { DescriptorSessionRouteCommandName } from '../../core/command-descriptor/registry.ts';
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
