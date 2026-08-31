import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';
import { runReplayCommand, runReplayTestCommand, type ReplaySession } from '../replay/index.ts';
import { handleCloseCommand } from './session-close.ts';
import { createReplayTestVideoOwner } from './session-replay-video-owner.ts';
import type { SessionCommandHandler } from './session.ts';

export const handleReplayCommand: SessionCommandHandler = async ({
  req,
  sessionName,
  logPath,
  sessionStore,
  invoke,
  invokeReplayAction,
}) =>
  await runReplayCommand({
    request: req,
    session: createReplaySession(sessionName, logPath, sessionStore),
    invoke: invokeReplayAction ?? invoke,
  });

export const handleReplayTestCommand: SessionCommandHandler = async ({
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
  platformResourceCleanup,
}) => {
  if (!platformResourceCleanup) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Platform resource cleanup was not supplied by root runtime composition',
    );
  }
  const video = createReplayTestVideoOwner({
    sessionStore,
    bindDevice,
    bindExactDevice,
    screenRecordingAdmissionLedger,
    requestScope,
    retainDeviceExecutionLock,
    throwIfCanceled,
  });
  return await runReplayTestCommand({
    request: req,
    session: createReplaySession(sessionName, logPath, sessionStore),
    invoke: invokeReplayAction ?? invoke,
    cleanupSession: async (testSessionName) =>
      await closeReplayTestSession({
        req,
        sessionName: testSessionName,
        logPath,
        sessionStore,
        leaseRegistry,
        inspectFacts,
        bindDevice,
        platformResourceCleanup,
      }),
    ...(video ? { video } : {}),
  });
};

function createReplaySession(name: string, logPath: string, store: SessionStore): ReplaySession {
  return { name, logPath, store };
}

type ReplayTestSessionCleanupParams = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  platformResourceCleanup: PlatformResourceCleanup;
}>;

async function closeReplayTestSession(params: ReplayTestSessionCleanupParams): Promise<void> {
  const { req, sessionName, logPath, sessionStore } = params;
  if (!sessionStore.get(sessionName)) return;
  const closeResponse = await handleCloseCommand({
    req: {
      token: req.token,
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
      meta: req.meta,
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry: params.leaseRegistry,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
    platformResourceCleanup: params.platformResourceCleanup,
  });
  if (closeResponse.ok) return;
  throw new AppError(closeResponse.error.code, closeResponse.error.message, {
    ...(closeResponse.error.details ?? {}),
    ...(closeResponse.error.hint ? { hint: closeResponse.error.hint } : {}),
  });
}
