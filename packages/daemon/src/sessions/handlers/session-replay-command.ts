import {
  getRequestDeadlineMs,
  getRequestSignal,
  isRequestCanceled,
} from '@agent-device/host-kit/request';
import { Deadline, retryWithPolicy } from '@agent-device/host-kit/retry';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { resolveSessionTestArtifactsRoot } from '@agent-device/daemon-contracts/session-artifact-paths';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import {
  SessionCoordinator,
  type WithSessionExecutionLock,
  type SessionStore,
} from '../../core/session-store.ts';
import type { SessionRef, SessionState } from '../../core/session-state.ts';
import { bindInternalObservationAuthority } from '../../execution/internal-observation.ts';
import type { LeaseLifecycleProvider } from '@agent-device/contracts/device';
import type { LeaseRegistry } from '../../resources/lease-registry.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
  RuntimeAdmissionBindings,
} from '../../core/request-runtime-binding.ts';
import type { PlatformResourceCleanup } from '../../core/platform-resource-cleanup.ts';
import { runReplayCommand } from '@agent-device/replay-port/native-command';
import { runReplayTestCommand } from '@agent-device/replay-port/test-command';
import { bindReplaySession } from '@agent-device/replay-port/replay-session-binding';
import {
  replayInvokeOverDispatch,
  splitReplayCommandRequest,
} from '@agent-device/replay-port/replay-dispatch-envelope';
import type {
  ReplayDaemonDependencies,
  ReplaySession,
} from '@agent-device/replay-port/command-types';
import { createReplayCoordinator } from '../session-replay-coordinator.ts';
import { assertSessionSelectorMatches } from '../../core/session-selector.ts';
import { resolveSessionScope } from '../session-routing.ts';
import { resolveEffectiveOpenRuntimeHints } from '../session-runtime.ts';
import { captureSnapshot } from '../../core/snapshot-capture.ts';
import { buildRuntimeCaptureInput } from '../../core/snapshot-runtime-capture-input.ts';
import type { BoundSnapshotCapture } from '../../core/snapshot-runtime-binding.ts';
import { resolveObservationCapture } from '../../core/observation-capture.ts';
import { handleSessionCloseCommands } from '../session-lifecycle/internal/session-close.ts';
import { onDelegatingLedger } from '../../core/request-ended-leases.ts';
import { createReplayTestVideoOwner } from './session-replay-video-owner.ts';
import type { SessionCommandHandler } from './session-command-input.ts';

/** The daemon policy replay consults without owning. */
export const replayDaemonDependencies: ReplayDaemonDependencies = { resolveSessionScope };

/**
 * The request's admission seams (#4622), which let replay bind the SAME request-bound capture the
 * commands it dispatches bind. `meta` rides along so the capture's execution metadata carries this
 * request's identity, runner overrides, and lease context like any other request-bound capture.
 *
 * A caller that composes no admission at all — the seam of a unit test that never binds a device —
 * leaves every capture on the owner's own snapshot path. Root composition always supplies one, so
 * a replay run driven through the daemon never takes that branch.
 */
export type ReplayCaptureAdmission = Readonly<{ meta?: DaemonRequest['meta'] }> &
  RuntimeAdmissionBindings;

/** What a replay run with no composed admission resolves every capture cell to. */
const NO_REPLAY_CAPTURE: Promise<BoundSnapshotCapture | undefined> = Promise.resolve(undefined);

export const handleReplayCommand: SessionCommandHandler = async ({
  req,
  host,
  sessionName,
  logPath,
  sessionStore,
  invoke,
  invokeReplayAction,
  inspectFacts,
  bindDevice,
  platformServices,
}) =>
  await runReplayCommand({
    ...splitReplayCommandRequest(req),
    host,
    session: createReplaySession(sessionName, logPath, sessionStore, {
      meta: req.meta,
      inspectFacts,
      bindDevice,
      platformServices,
    }),
    invoke: replayInvokeOverDispatch(invokeReplayAction ?? invoke, req),
    dependencies: replayDaemonDependencies,
  });

export const handleReplayTestCommand: SessionCommandHandler = async ({
  host,
  req,
  sessionName,
  logPath,
  sessionStore,
  leaseRegistry,
  leaseLifecycleProvider,
  invoke,
  invokeReplayAction,
  bindDevice,
  platformServices,
  inspectFacts,
  bindExactDevice,
  screenRecordingAdmissionLedger,
  requestScope,
  throwIfCanceled,
  withSessionExecutionLock,
  platformResourceCleanup,
  deviceShutdownDenied,
}) => {
  if (!platformResourceCleanup || !withSessionExecutionLock) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Replay test session cleanup and locks were not supplied by the router',
    );
  }
  const coordinator = new SessionCoordinator(sessionStore);
  const attempts = new Map<string, { running: boolean; requestId?: string; ref?: SessionRef }>();
  const isRunning = (name: string) => {
    const attempt = attempts.get(name);
    return attempt?.running === true && !isRequestCanceled(attempt.requestId);
  };
  const running = (name: string) => (isRunning(name) ? coordinator.pin(req, name) : undefined);
  const completed = (name: string) => {
    const ref = attempts.get(name)?.ref;
    return ref && sessionStore.resolveCurrent(ref) ? sessionStore.refresh(ref) : undefined;
  };
  const video = createReplayTestVideoOwner({
    sessionStore,
    withSessionExecutionLock,
    sessionRef: (name, phase) => (phase === 'start' ? running(name) : completed(name)),
    bindDevice,
    platformServices,
    bindExactDevice,
    screenRecordingAdmissionLedger,
    requestScope,
    throwIfCanceled,
  });
  const capture: ReplayCaptureAdmission = {
    meta: req.meta,
    inspectFacts,
    bindDevice,
    platformServices,
  };
  const suiteRequest = req.internal?.publicNetworkOnly
    ? {
        ...req,
        flags: {
          ...req.flags,
          artifactsDir: resolveSessionTestArtifactsRoot(
            sessionStore.resolveSessionDir(sessionName),
          ),
        },
      }
    : req;
  return await runReplayTestCommand({
    ...splitReplayCommandRequest(suiteRequest),
    host,
    session: createReplaySession(sessionName, logPath, sessionStore, capture),
    runAttempt: async (name, requestId, task) =>
      await withSessionExecutionLock(name, async () => {
        coordinator.pin(req, name);
        const attempt: { running: boolean; requestId?: string; ref?: SessionRef } = {
          running: true,
          requestId,
        };
        attempts.set(name, attempt);
        try {
          return await task();
        } finally {
          attempt.running = false;
          attempt.ref = coordinator.pin(req, name);
        }
      }),
    createSession: (name, testLogPath, phase) =>
      createReplaySession(
        name,
        testLogPath,
        sessionStore,
        capture,
        phase === 'replay' ? () => running(name) : () => completed(name),
        withSessionExecutionLock,
        () => isRunning(name),
      ),
    invoke: replayInvokeOverDispatch(invokeReplayAction ?? invoke, req),
    dependencies: replayDaemonDependencies,
    cleanupSession: async (name) => {
      // A timed-out attempt can still hold the lock. Its late cleanup runs after it settles.
      const lifetime = completed(name)?.lifetime;
      if (!lifetime) return [];
      let acquiring = true;
      const closePinned = (signal?: AbortSignal) =>
        withSessionExecutionLock(
          name,
          async (holdDevice) => {
            const ref = completed(name);
            if (ref?.lifetime !== lifetime) return [];
            await holdDevice(ref.session.device.id);
            acquiring = false;
            return await closeReplayTestSession({
              host,
              req,
              ref,
              logPath,
              sessionStore,
              leaseRegistry,
              leaseLifecycleProvider,
              inspectFacts,
              bindDevice,
              platformServices,
              platformResourceCleanup,
              deviceShutdownDenied,
            });
          },
          signal,
        );
      const lockBusy = (error: unknown) =>
        acquiring &&
        error instanceof AppError &&
        error.code === 'DEVICE_IN_USE' &&
        error.details?.reason === 'DEVICE_EXECUTION_LOCK_BUSY';
      try {
        return await closePinned();
      } catch (error) {
        if (!lockBusy(error)) throw error;
        const signal = getRequestSignal(req.meta?.requestId);
        const expiresAt = getRequestDeadlineMs(req.meta?.requestId);
        const remaining = expiresAt === undefined ? undefined : expiresAt - Date.now();
        if (signal?.aborted || (remaining !== undefined && remaining <= 0)) throw error;
        return await retryWithPolicy(
          () => closePinned(signal),
          { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 200, jitter: 0, shouldRetry: lockBusy },
          {
            signal,
            deadline: remaining === undefined ? undefined : Deadline.fromTimeoutMs(remaining),
          },
        );
      }
    },
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
  capture?: ReplayCaptureAdmission,
  lookup: () => SessionRef | undefined = () => store.lookup(name),
  withSessionExecutionLock?: WithSessionExecutionLock,
  isActive?: () => boolean,
): ReplaySession {
  const updateSession = (mutate: (session: SessionState) => void): boolean => {
    const session = lookup()?.session;
    if (!session) return false;
    mutate(session);
    return true;
  };
  // One read set for both views: the narrowed one the port binds over, and the full-record one the
  // repair coordinator writes through.
  const getRuntimeHints = (): ReturnType<SessionStore['getRuntimeHints']> => {
    lookup();
    return store.getRuntimeHints(name);
  };
  const reads = {
    get: () => lookup()?.session,
    lookup,
    getRuntimeHints,
    ensureSessionDir: () => store.ensureSessionDir(name),
  };
  let captureCell:
    | {
        lifetime: SessionRef['lifetime'];
        device: SessionState['device'];
        booted: boolean;
        hasApp: boolean;
        binding: Promise<BoundSnapshotCapture | undefined>;
      }
    | undefined;
  const bindDevice = capture?.bindDevice;
  // Bypasses the request's device-key cache on purpose: that key can outlive a close, while this
  // cell re-admits on a new lifetime or device object. Each bypass binding is owned by the request's
  // cleanup stack and released when the request ends, like every other request binding; capture
  // operations resolve their source per call, so a superseded binding holds no capture state.
  const bindCaptureDevice: BindDeviceRuntime | undefined = bindDevice
    ? (device, use) => bindDevice(device, use, 'bypass')
    : undefined;
  const bindCaptureFor = (
    lifetime: SessionRef['lifetime'],
    session: SessionState,
  ): Promise<BoundSnapshotCapture | undefined> => {
    if (!capture) return NO_REPLAY_CAPTURE;
    const { device } = session;
    const booted = device.booted === true;
    const hasApp = session.appBundleId !== undefined;
    // Open can publish a refreshed device in the same lifetime. Ordinary snapshot and action
    // updates preserve both. Replay owns reuse here because the request device key can outlive close.
    if (
      captureCell?.lifetime === lifetime &&
      captureCell.device === device &&
      captureCell.booted === booted &&
      captureCell.hasApp === hasApp
    ) {
      return captureCell.binding;
    }
    const binding = resolveObservationCapture({
      command: 'replay',
      session,
      inspectFacts: capture.inspectFacts,
      platformServices: capture.platformServices,
      bindDevice: bindCaptureDevice,
    }).then((outcome) => {
      // The owner discloses each kind and splits stable from retryable; replay only acts on
      // retry eligibility: a retryable cell is dropped so the next verification re-admits, while a
      // refusal or a bound capture is kept for the cell's lifetime.
      if (outcome.kind === 'retryable' && captureCell?.binding === binding) captureCell = undefined;
      return outcome.kind === 'captured' ? outcome.capture : undefined;
    });
    captureCell = { lifetime, device, booted, hasApp, binding };
    return binding;
  };
  return bindReplaySession(name, logPath, reads, {
    createCoordinator: () =>
      createReplayCoordinator({
        sessionStore: reads,
        mutationStore: {
          update: updateSession,
          clearRepairTombstone: () => store.clearRepairTombstone(name),
        },
        hostCwd: store.host.cwd,
      }),
    assertSelectorMatches: (flags) => {
      const ref = lookup();
      if (ref) assertSessionSelectorMatches(ref, flags);
    },
    resolveOpenRuntimeHints: ({ request, device, platform }) =>
      resolveEffectiveOpenRuntimeHints({
        req: request,
        sessionStore: {
          getRuntimeHints: (requestedSessionName) =>
            requestedSessionName === name ? getRuntimeHints() : undefined,
        },
        sessionName: name,
        device,
        platform,
      }),
    bindAuthority: (signal) => {
      const ref = lookup();
      return {
        ...bindInternalObservationAuthority({ sessionStore: store, ref, signal, isActive }),
        capture: async ({ flags, logPath: captureLogPath }) => {
          if (!ref) {
            throw new AppError('NO_ACTIVE_SESSION', `Session "${name}" is no longer active.`);
          }
          const captureCurrent = async () => {
            signal?.throwIfAborted();
            if (isActive?.() === false)
              throw new AppError('NO_ACTIVE_SESSION', `Session "${name}" is no longer active.`);
            const session = store.requireCurrent(ref);
            const bound = await bindCaptureFor(ref.lifetime, session);
            signal?.throwIfAborted();
            return await captureSnapshot({
              device: session.device,
              session,
              flags,
              logPath: captureLogPath,
              signal,
              ...(bound
                ? {
                    captureData: async () =>
                      await bound(
                        buildRuntimeCaptureInput({
                          flags,
                          logPath: captureLogPath,
                          meta: capture?.meta,
                          session,
                          snapshotScope: undefined,
                          signal,
                        }),
                      ),
                  }
                : {}),
            });
          };
          if (!withSessionExecutionLock) return await captureCurrent();
          return await withSessionExecutionLock(ref.address, async (holdDevice) => {
            await holdDevice(store.requireCurrent(ref).device.id);
            return await captureCurrent();
          });
        },
      };
    },
  });
}

type ReplayTestSessionCleanupParams = Readonly<{
  host: HostEnvironment;
  req: DaemonRequest;
  ref: SessionRef;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
  platformResourceCleanup: PlatformResourceCleanup;
  deviceShutdownDenied?: boolean;
}>;

async function closeReplayTestSession(
  params: ReplayTestSessionCleanupParams,
): Promise<readonly string[]> {
  const { req, ref, logPath, sessionStore } = params;
  const sessionName = ref.address;
  const closeResponse = await handleSessionCloseCommands({
    host: params.host,
    req: onDelegatingLedger(
      {
        token: req.token,
        session: sessionName,
        command: 'close',
        positionals: [],
        flags: {},
        meta: req.meta,
        internal: {
          cleanupIntent: 'suite-owned-test-session',
        },
      },
      req,
    ),
    sessionName,
    sessionRef: ref,
    logPath,
    sessionStore,
    leaseRegistry: params.leaseRegistry,
    leaseLifecycleProvider: params.leaseLifecycleProvider,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
    platformResourceCleanup: params.platformResourceCleanup,
    deviceShutdownDenied: params.deviceShutdownDenied,
  });
  if (closeResponse.ok) return readResponseWarnings(closeResponse.data);
  throw new AppError(closeResponse.error.code, closeResponse.error.message, {
    ...(closeResponse.error.details ?? {}),
    ...(closeResponse.error.hint ? { hint: closeResponse.error.hint } : {}),
  });
}
