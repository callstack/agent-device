import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../daemon-request.ts';
import type { SessionState } from '../session-state.ts';
import type { SessionStore } from '../session-store.ts';
import { bindInternalObservationAuthority } from '../internal-observation.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { PlatformResourceCleanup } from '../platform-resource-cleanup.ts';
import {
  bindReplaySession,
  replayInvokeOverDispatch,
  runReplayCommand,
  runReplayTestCommand,
  splitReplayCommandRequest,
  type ReplayDaemonDependencies,
  type ReplaySession,
} from '../replay/index.ts';
import { createReplayCoordinator } from '../session-replay-coordinator.ts';
import { assertSessionSelectorMatches } from '../session-selector.ts';
import { resolveSessionScope } from '../session-routing.ts';
import { resolveEffectiveOpenRuntimeHints } from '../session-runtime.ts';
import { captureSnapshot } from '../snapshot-capture.ts';
import { handleSessionCloseCommands } from '../session-lifecycle/index.ts';
import { createReplayTestVideoOwner } from './session-replay-video-owner.ts';
import type { SessionCommandHandler } from './session-command-input.ts';

/** The daemon policy replay consults without owning. */
export const replayDaemonDependencies: ReplayDaemonDependencies = { resolveSessionScope };

export const handleReplayCommand: SessionCommandHandler = async ({
  req,
  sessionName,
  logPath,
  sessionStore,
  invoke,
  invokeReplayAction,
}) =>
  await runReplayCommand({
    ...splitReplayCommandRequest(req),
    session: createReplaySession(sessionName, logPath, sessionStore),
    invoke: replayInvokeOverDispatch(invokeReplayAction ?? invoke, req),
    dependencies: replayDaemonDependencies,
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
    ...splitReplayCommandRequest(req),
    session: createReplaySession(sessionName, logPath, sessionStore),
    createSession: (testSessionName, testLogPath) =>
      createReplaySession(testSessionName, testLogPath, sessionStore),
    invoke: replayInvokeOverDispatch(invokeReplayAction ?? invoke, req),
    dependencies: replayDaemonDependencies,
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

/**
 * Binds one replay session over the daemon's live record. The container hands the port its reads;
 * the policy hands back what the port may consult but not own: the repair gateway, the
 * ref-publication authority, selector admission, open runtime hints and snapshot capture.
 */
export function createReplaySession(
  name: string,
  logPath: string,
  store: SessionStore,
): ReplaySession {
  const updateSession = (mutate: (session: SessionState) => void): boolean => {
    const session = store.get(name);
    if (!session) return false;
    mutate(session);
    store.set(name, session);
    return true;
  };
  // One read set for both views: the narrowed one the port binds over, and the full-record one the
  // repair coordinator writes through.
  const reads = {
    get: () => store.get(name),
    lookup: () => store.lookup(name),
    getRuntimeHints: () => store.getRuntimeHints(name),
    ensureSessionDir: () => store.ensureSessionDir(name),
  };
  return bindReplaySession(name, logPath, reads, {
    createCoordinator: () =>
      createReplayCoordinator({
        sessionStore: reads,
        mutationStore: {
          update: updateSession,
          clearRepairTombstone: () => store.clearRepairTombstone(name),
        },
      }),
    assertSelectorMatches: (flags) => {
      const ref = store.lookup(name);
      if (ref) assertSessionSelectorMatches(ref, flags);
    },
    resolveOpenRuntimeHints: ({ request, device, platform }) =>
      resolveEffectiveOpenRuntimeHints({
        req: request,
        sessionStore: {
          getRuntimeHints: (requestedSessionName) =>
            requestedSessionName === name ? store.getRuntimeHints(name) : undefined,
        },
        sessionName: name,
        device,
        platform,
      }),
    bindAuthority: (signal) =>
      bindInternalObservationAuthority({
        sessionStore: { get: () => store.get(name), update: updateSession },
        sessionName: name,
        ...(signal ? { signal } : {}),
      }),
    capture: async ({ flags, logPath: captureLogPath }) => {
      const session = store.get(name);
      if (!session) {
        throw new AppError('NO_ACTIVE_SESSION', `Session "${name}" is no longer active.`);
      }
      return await captureSnapshot({
        device: session.device,
        session,
        flags,
        logPath: captureLogPath,
      });
    },
  });
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
  const closeResponse = await handleSessionCloseCommands({
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
