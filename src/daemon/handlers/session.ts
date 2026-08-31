import type { DaemonResponse } from '../types.ts';
import { handleReleaseMaterializedPathsCommand } from './session-app-source-deployment.ts';
import { handleRuntimeCommand } from './session-runtime-command.ts';
import { handleKeyboardCommand, handleAppEventCommand } from './session-selector-dispatch.ts';
import { handleCloseCommand } from './session-close.ts';
import { handleSessionAppDeploymentCommand } from './session-app-deployment-route.ts';
import { runBatchCommands } from './session-batch.ts';
import {
  handleSessionInventoryCommands,
  handleSessionOpenCommands,
} from '../session-lifecycle/index.ts';
import { handleSessionStateCommands } from './session-state.ts';
import { handleSessionObservabilityCommands } from './session-observability.ts';
import { handleReplayCommand, handleReplayTestCommand } from './session-replay-command.ts';
import { handleSessionScriptPublication } from './session-script-publication.ts';
import { handleSessionClipboardCommand } from './session-clipboard.ts';
import { handleDoctorCommand } from './session-doctor.ts';
import { handlePrepareCommand } from './session-prepare.ts';
import type {
  SessionCommandHandler,
  SessionCommandInput,
  SessionCommandParams,
} from './session-command-input.ts';
import type {
  SessionInventoryCommandInput,
  SessionOpenCommandInput,
} from '../session-lifecycle/index.ts';
import type { DescriptorSessionRouteCommandName } from '../../core/command-descriptor/registry.ts';
import { LeaseRegistry } from '../lease-registry.ts';

const handleSessionInventoryCommandGroup: SessionCommandHandler = (
  params: SessionCommandParams & SessionInventoryCommandInput,
) => handleSessionInventoryCommands(params);

const handleSessionOpenCommandGroup: SessionCommandHandler = (params) =>
  handleSessionOpenCommands({
    req: params.req,
    sessionName: params.sessionName,
    logPath: params.logPath,
    sessionStore: params.sessionStore,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
    reconcileOrphanedDeviceClaim: params.reconcileOrphanedDeviceClaim,
  } satisfies SessionOpenCommandInput);

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

/**
 * Descriptor-driven exhaustive dispatch table for the daemon's `session`
 * route (mirrors `DISPATCH_HANDLERS` in src/core/dispatch-resolve.ts and
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
  runtime: async ({ req, sessionName, logPath, sessionStore, inspectFacts, bindDevice }) =>
    await handleRuntimeCommand({
      req,
      sessionName,
      logPath,
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
  open: handleSessionOpenCommandGroup,
  replay: handleReplayCommand,
  test: handleReplayTestCommand,
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
    platformResourceCleanup,
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
      platformResourceCleanup,
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
    providerAppCatalog,
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
    platformResourceCleanup,
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
    providerAppCatalog,
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
    platformResourceCleanup,
  });
}
