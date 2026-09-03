import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { errorResponse } from '../response.ts';
import { handleAlertCommand } from './snapshot-alert.ts';
import { handleSettingsCommand, parseSettingsArgs } from './snapshot-settings.ts';
import { dispatchSnapshotDiffViaRuntime } from '../snapshot-diff-runtime.ts';
import { dispatchSnapshotViaRuntime } from '../snapshot-runtime.ts';
import { dispatchWaitViaRuntime } from '../wait-runtime.ts';
import { resolveSessionDevice, withSessionlessRunnerCleanup } from '../snapshot-session.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';

type SnapshotCommandParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  platformResourceCleanup?: PlatformResourceCleanup;
};

type SnapshotCommandHandler = (params: SnapshotCommandParams) => Promise<DaemonResponse>;

const SNAPSHOT_COMMAND_HANDLER_IMPLS = {
  snapshot: async ({
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformResourceCleanup,
  }) =>
    await dispatchSnapshotViaRuntime({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformResourceCleanup,
    }),
  diff: async ({
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformResourceCleanup,
  }) => {
    if (req.positionals?.[0] !== 'snapshot') {
      return errorResponse('INVALID_ARGS', 'diff currently supports only: diff snapshot');
    }
    return await dispatchSnapshotDiffViaRuntime({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformResourceCleanup,
    });
  },
  wait: async ({
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformResourceCleanup,
  }) =>
    await dispatchWaitViaRuntime({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformResourceCleanup,
    }),
  alert: async ({
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts,
    bindDevice,
    platformResourceCleanup,
  }) => {
    const { session, device } = await resolveSessionDevice(sessionStore, sessionName, req.flags);
    return await withSessionlessRunnerCleanup(
      session,
      device,
      async () => {
        return await handleAlertCommand({
          req,
          logPath,
          sessionStore,
          session,
          device,
          inspectFacts,
          bindDevice,
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
    platformResourceCleanup,
  }) => {
    const parsedSettings = parseSettingsArgs(req);
    if (!parsedSettings.ok) return parsedSettings;
    const { session, device } = await resolveSessionDevice(sessionStore, sessionName, req.flags);
    return await withSessionlessRunnerCleanup(
      session,
      device,
      async () => {
        return await handleSettingsCommand({
          req,
          logPath,
          sessionStore,
          session,
          device,
          parsed: parsedSettings.parsed,
          inspectFacts,
          bindDevice,
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
