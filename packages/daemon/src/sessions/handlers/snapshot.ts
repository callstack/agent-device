import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { SessionStore } from '../../core/session-store.ts';
import { handleAlertCommand } from '../../execution/handlers/snapshot-alert.ts';
import {
  handleSettingsCommand,
  parseSettingsArgs,
} from '../../execution/handlers/snapshot-settings.ts';
import { dispatchSnapshotDiffViaRuntime } from '../snapshot-diff-runtime.ts';
import { dispatchSnapshotViaRuntime } from '../snapshot-runtime.ts';
import { dispatchWaitViaRuntime } from '../../execution/wait-runtime.ts';
import { resolveSessionDevice, withSessionlessRunnerCleanup } from '../../core/snapshot-session.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../core/request-runtime-binding.ts';
import type { PlatformResourceCleanup } from '../../core/platform-resource-cleanup.ts';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import { errorResponse } from '@agent-device/kernel/contracts';

type SnapshotCommandParams = {
  createCommandSurface: CreateDaemonCommandSurface;
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
  platformResourceCleanup?: PlatformResourceCleanup;
};

type SnapshotCommandHandler = (params: SnapshotCommandParams) => Promise<DaemonResponse>;

const SNAPSHOT_COMMAND_HANDLER_IMPLS = {
  snapshot: async ({
    req,
    createCommandSurface,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformServices,
    platformResourceCleanup,
  }) =>
    await dispatchSnapshotViaRuntime({
      createCommandSurface,
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformServices,
      platformResourceCleanup,
    }),
  diff: async ({
    req,
    createCommandSurface,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformServices,
    platformResourceCleanup,
  }) => {
    if (req.positionals?.[0] !== 'snapshot') {
      return errorResponse('INVALID_ARGS', 'diff currently supports only: diff snapshot');
    }
    return await dispatchSnapshotDiffViaRuntime({
      createCommandSurface,
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformServices,
      platformResourceCleanup,
    });
  },
  wait: async ({
    req,
    createCommandSurface,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformServices,
    platformResourceCleanup,
  }) =>
    await dispatchWaitViaRuntime({
      createCommandSurface,
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformServices,
      platformResourceCleanup,
    }),
  alert: async ({
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformServices,
    platformResourceCleanup,
  }) => {
    const { ref, session, device } = await resolveSessionDevice(sessionStore, sessionName, req);
    return await withSessionlessRunnerCleanup(
      session,
      device,
      async () => {
        return await handleAlertCommand({
          req,
          logPath,
          sessionStore,
          ref,
          device,
          inspectFacts,
          bindDevice,
          platformServices,
        });
      },
      platformResourceCleanup,
    );
  },
  settings: async ({
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformServices,
    platformResourceCleanup,
  }) => {
    const parsedSettings = parseSettingsArgs(req);
    if (!parsedSettings.ok) return parsedSettings;
    const { ref, session, device } = await resolveSessionDevice(sessionStore, sessionName, req);
    return await withSessionlessRunnerCleanup(
      session,
      device,
      async () => {
        return await handleSettingsCommand({
          req,
          logPath,
          sessionStore,
          ref,
          device,
          parsed: parsedSettings.parsed,
          inspectFacts,
          bindDevice,
          platformServices,
        });
      },
      platformResourceCleanup,
    );
  },
} satisfies Record<string, SnapshotCommandHandler>;

export async function handleSnapshotCommands(
  params: SnapshotCommandParams,
): Promise<DaemonResponse | null> {
  const command = params.req.command;

  const handler =
    SNAPSHOT_COMMAND_HANDLER_IMPLS[command as keyof typeof SNAPSHOT_COMMAND_HANDLER_IMPLS];
  if (!handler) {
    return null;
  }

  return await handler(params);
}
