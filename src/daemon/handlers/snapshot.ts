import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { errorResponse } from './response.ts';
import { handleAlertCommand } from './snapshot-alert.ts';
import { handleSettingsCommand, parseSettingsArgs } from './snapshot-settings.ts';
import { dispatchSnapshotDiffViaRuntime } from '../snapshot-diff-runtime.ts';
import { dispatchSnapshotViaRuntime } from '../snapshot-runtime.ts';
import { dispatchWaitViaRuntime } from '../selector-runtime.ts';
import { resolveSessionDevice, withSessionlessRunnerCleanup } from './snapshot-session.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';

type SnapshotCommandParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
};

type SnapshotCommandHandler = (params: SnapshotCommandParams) => Promise<DaemonResponse>;

const SNAPSHOT_COMMAND_HANDLER_IMPLS = {
  snapshot: async ({ req, sessionName, logPath, sessionStore, inspectFacts, bindDevice }) =>
    await dispatchSnapshotViaRuntime({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
    }),
  diff: async ({ req, sessionName, logPath, sessionStore, inspectFacts, bindDevice }) => {
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
    });
  },
  wait: async ({ req, sessionName, logPath, sessionStore, inspectFacts, bindDevice }) =>
    await dispatchWaitViaRuntime({
      req,
      sessionName,
      logPath,
      sessionStore,
      inspectFacts,
      bindDevice,
    }),
  alert: async ({ req, sessionName, logPath, sessionStore }) => {
    const { session, device } = await resolveSessionDevice(sessionStore, sessionName, req.flags);
    return await withSessionlessRunnerCleanup(session, device, async () => {
      return await handleAlertCommand({
        req,
        logPath,
        sessionStore,
        session,
        device,
      });
    });
  },
  settings: async ({ req, sessionName, logPath, sessionStore }) => {
    const parsedSettings = parseSettingsArgs(req);
    if (!parsedSettings.ok) return parsedSettings;
    const { session, device } = await resolveSessionDevice(sessionStore, sessionName, req.flags);
    return await withSessionlessRunnerCleanup(session, device, async () => {
      return await handleSettingsCommand({
        req,
        logPath,
        sessionStore,
        session,
        device,
        parsed: parsedSettings.parsed,
      });
    });
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
