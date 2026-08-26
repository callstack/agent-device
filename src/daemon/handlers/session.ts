import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { handleReleaseMaterializedPathsCommand } from './session-app-source-deployment.ts';
import { handleRuntimeCommand } from './session-runtime-command.ts';
import { requireRuntimeBinding, requireRuntimeFacts } from './session-runtime-admission.ts';
import { handleOpenCommand } from './session-open.ts';
import { composeOpenWithInitialSnapshot } from './session-open-foreground.ts';
import { handleKeyboardCommand, handleAppEventCommand } from './session-selector-dispatch.ts';
import { handleCloseCommand } from './session-close.ts';
import { handleSessionAppDeploymentCommand } from './session-app-deployment-route.ts';
import { runBatchCommands } from './session-batch.ts';
import { handleSessionInventoryCommands } from './session-inventory.ts';
import { handleSessionStateCommands } from './session-state.ts';
import { handleSessionObservabilityCommands } from './session-observability.ts';
import { handleSessionReplayCommands } from './session-replay.ts';
import { handleSessionScriptPublication } from './session-script-publication.ts';
import { handleSessionClipboardCommand } from './session-clipboard.ts';
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
import type { AudioProbeAdmissionLedger } from '../audio-probe-admission-ledger.ts';
import type { PerfCaptureAdmissionLedger } from '../perf-capture-admission-ledger.ts';
import type { ScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { HostDiagnostics } from '@agent-device/contracts/host-diagnostics';

export type SessionCommandInput = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry?: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  invoke: DaemonInvokeFn;
  invokeReplayAction?: DaemonInvokeFn;
  /**
   * Request-scoped Android adb transport override, opaque to the daemon (the
   * `transportOverrides` pattern from `@agent-device/contracts/host-diagnostics`); the
   * platform owner narrows it at its own boundary.
   */
  androidAdbExecutor?: unknown;
  bindDevice?: BindDeviceRuntime;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindExactDevice?: BindExactDeviceRuntime;
  appLogAdmissionLedger?: AppLogAdmissionLedger;
  audioProbeAdmissionLedger?: AudioProbeAdmissionLedger;
  perfCaptureAdmissionLedger?: PerfCaptureAdmissionLedger;
  screenRecordingAdmissionLedger?: ScreenRecordingAdmissionLedger;
  hostDiagnostics?: HostDiagnostics;
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
  bindDevice,
  inspectFacts,
  appLogAdmissionLedger,
  audioProbeAdmissionLedger,
  perfCaptureAdmissionLedger,
  throwIfCanceled,
}) =>
  await handleSessionObservabilityCommands({
    req,
    sessionName,
    sessionStore,
    bindDevice,
    inspectFacts,
    appLogAdmissionLedger,
    audioProbeAdmissionLedger,
    perfCaptureAdmissionLedger,
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
    hostDiagnostics,
    inspectFacts,
    bindDevice,
  }) =>
    await handleDoctorCommand({
      req,
      sessionName,
      sessionStore,
      androidAdbExecutor,
      hostDiagnostics,
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
  clipboard: async ({ req, sessionName, logPath, sessionStore, inspectFacts, bindDevice }) =>
    await handleSessionClipboardCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
    }),
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
  'trigger-app-event': handleAppEventCommand,
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
    audioProbeAdmissionLedger,
    perfCaptureAdmissionLedger,
    screenRecordingAdmissionLedger,
    hostDiagnostics,
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
    audioProbeAdmissionLedger,
    perfCaptureAdmissionLedger,
    screenRecordingAdmissionLedger,
    hostDiagnostics,
    requestScope,
    retainDeviceExecutionLock,
    throwIfCanceled,
    reconcileOrphanedDeviceClaim,
  });
}
