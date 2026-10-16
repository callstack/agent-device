import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { handleReleaseMaterializedPathsCommand } from './session-app-source-deployment.ts';
import { handleRuntimeCommand } from './session-runtime-command.ts';
import {
  handleKeyboardCommand,
  handleAppEventCommand,
} from '../../execution/handlers/session-selector-dispatch.ts';
import { handleSessionAppDeploymentCommand } from './session-app-deployment-route.ts';
import { runBatchCommands } from './session-batch.ts';
import { handleSessionCloseCommands } from '../session-lifecycle/internal/session-close.ts';
import { handleSessionInventoryCommands } from '../session-lifecycle/internal/inventory.ts';
import { handleSessionOpenCommands } from '../session-lifecycle/internal/session-open.ts';
import { handleBootCommand } from './session-boot.ts';
import { handleShutdownCommand } from './session-shutdown.ts';
import { handleAppStateCommand } from './session-appstate.ts';
import { handleSessionObservabilityCommands } from '../session-observability/internal/session-observability.ts';
import { handleReplayCommand, handleReplayTestCommand } from './session-replay-command.ts';
import { handleSessionScriptPublication } from './session-script-publication.ts';
import { handleSessionClipboardCommand } from '../../execution/handlers/session-clipboard.ts';
import { handleDoctorCommand } from './session-doctor.ts';
import { handlePrepareCommand } from './session-prepare.ts';
import type {
  SessionCommandHandler,
  SessionCommandInput,
  SessionCommandParams,
} from './session-command-input.ts';
import type { SessionCloseCommandInput } from '../session-lifecycle/internal/session-close.ts';
import type { SessionInventoryCommandInput } from '../session-lifecycle/internal/inventory.ts';
import type { SessionOpenCommandInput } from '../session-lifecycle/internal/session-open.ts';
import type { SessionObservabilityCommandInput } from '../session-observability/internal/session-observability.ts';
import type { DescriptorSessionRouteCommandName } from '@agent-device/command-registry/registry';
import { LeaseRegistry } from '../../resources/lease-registry.ts';

const handleSessionInventoryCommandGroup: SessionCommandHandler = (
  params: SessionCommandParams & SessionInventoryCommandInput,
) => handleSessionInventoryCommands(params);

const handleSessionOpenCommandGroup: SessionCommandHandler = (params) =>
  handleSessionOpenCommands({
    req: params.req,
    createCommandSurface: params.createCommandSurface,
    sessionName: params.sessionName,
    logPath: params.logPath,
    sessionStore: params.sessionStore,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
    reconcileOrphanedDeviceClaim: params.reconcileOrphanedDeviceClaim,
  } satisfies SessionOpenCommandInput);

const handleSessionCloseCommandGroup: SessionCommandHandler = (params) =>
  handleSessionCloseCommands({
    req: params.req,
    sessionName: params.sessionName,
    logPath: params.logPath,
    sessionStore: params.sessionStore,
    leaseRegistry: params.leaseRegistry,
    leaseLifecycleProvider: params.leaseLifecycleProvider,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
    platformResourceCleanup: params.platformResourceCleanup,
  } satisfies SessionCloseCommandInput);

const handleSessionObservabilityCommandGroup: SessionCommandHandler = async ({
  req,
  sessionName,
  sessionStore,
  bindDevice,
  platformServices,
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
    platformServices,
    inspectFacts,
    appLogAdmissionLedger,
    audioProbeAdmissionLedger,
    perfCaptureAdmissionLedger,
    throwIfCanceled,
  } satisfies SessionObservabilityCommandInput);

/**
 * Descriptor-driven exhaustive dispatch table for the daemon's `session`
 * route (mirrors `DISPATCH_HANDLERS` in -device/device-selection/dispatch-resolve and
 * `SNAPSHOT_COMMAND_HANDLER_IMPLS` in packages/daemon/src/sessions/handlers/snapshot.ts). The
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
  boot: handleBootCommand,
  shutdown: handleShutdownCommand,
  appstate: handleAppStateCommand,
  session_save_script: async ({ req, sessionName, sessionStore }) =>
    handleSessionScriptPublication({ req, sessionName, sessionStore }),
  runtime: async ({
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformServices,
  }) =>
    await handleRuntimeCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformServices,
    }),
  clipboard: async ({
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformServices,
  }) =>
    await handleSessionClipboardCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformServices,
    }),
  keyboard: handleKeyboardCommand,
  perf: handleSessionObservabilityCommandGroup,
  logs: handleSessionObservabilityCommandGroup,
  events: handleSessionObservabilityCommandGroup,
  network: handleSessionObservabilityCommandGroup,
  audio: handleSessionObservabilityCommandGroup,
  prepare: async ({
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformServices,
  }) =>
    await handlePrepareCommand({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformServices,
    }),
  install: handleSessionAppDeploymentCommand,
  reinstall: handleSessionAppDeploymentCommand,
  uninstall: handleSessionAppDeploymentCommand,
  install_source: handleSessionAppDeploymentCommand,
  release_materialized_paths: async ({ req }) =>
    await handleReleaseMaterializedPathsCommand({ req }),
  push: handleSessionAppDeploymentCommand,
  'trigger-app-event': handleAppEventCommand,
  open: handleSessionOpenCommandGroup,
  replay: handleReplayCommand,
  test: handleReplayTestCommand,
  batch: async ({ req, sessionName, invoke }) => await runBatchCommands(req, sessionName, invoke),
  close: handleSessionCloseCommandGroup,
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
    providerAppCatalog,
    invoke,
    invokeReplayAction,
    androidAdbExecutor,
    inspectFacts,
    bindDevice,
    platformServices,
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
    platformResourceCleanup,
  } = params;

  const handler =
    SESSION_COMMAND_HANDLER_IMPLS[req.command as keyof typeof SESSION_COMMAND_HANDLER_IMPLS];
  if (!handler) return null;

  return await handler({
    req,
    createCommandSurface: params.createCommandSurface,
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider,
    providerAppCatalog,
    invoke,
    invokeReplayAction,
    androidAdbExecutor,
    inspectFacts,
    bindDevice,
    platformServices,
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
    platformResourceCleanup,
  });
}
