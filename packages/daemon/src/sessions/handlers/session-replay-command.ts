import { resolveSessionTestArtifactsRoot } from '@agent-device/daemon-contracts/session-artifact-paths';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../../core/session-state.ts';
import type { SessionStore } from '../../core/session-store.ts';
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
import { onDelegatingLedger, recordEndedLease } from '../../core/request-ended-leases.ts';
import { buildSessionLeaseFromRequest } from '../../core/lease-context.ts';
import { releaseSessionLease } from '../lease-lifecycle.ts';
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
    platformServices,
    bindExactDevice,
    screenRecordingAdmissionLedger,
    requestScope,
    retainDeviceExecutionLock,
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
  const attemptReq: DaemonRequest = {
    ...req,
    internal: {
      ...req.internal,
      suiteHostSession: sessionName,
    },
  };
  try {
    return await runReplayTestCommand({
      ...splitReplayCommandRequest(suiteRequest),
      host,
      session: createReplaySession(sessionName, logPath, sessionStore, capture),
      createSession: (testSessionName, testLogPath) =>
        createReplaySession(testSessionName, testLogPath, sessionStore, capture),
      invoke: replayInvokeOverDispatch(invokeReplayAction ?? invoke, attemptReq),
      dependencies: replayDaemonDependencies,
      cleanupSession: async (testSessionName) =>
        await closeReplayTestSession({
          host,
          req,
          sessionName: testSessionName,
          logPath,
          sessionStore,
          leaseRegistry,
          leaseLifecycleProvider,
          inspectFacts,
          bindDevice,
          platformServices,
          platformResourceCleanup,
        }),
      ...(video ? { video } : {}),
    });
  } finally {
    await releaseUnheldSuiteRequestLease({
      req,
      sessionName,
      sessionStore,
      leaseRegistry,
      leaseLifecycleProvider,
    });
  }
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
): ReplaySession {
  const updateSession = (mutate: (session: SessionState) => void): boolean => {
    const session = store.get(name);
    if (!session) return false;
    mutate(session);
    return true;
  };
  // One read set for both views: the narrowed one the port binds over, and the full-record one the
  // repair coordinator writes through.
  const reads = {
    get: () => store.get(name),
    lookup: () => store.lookup(name),
    getRuntimeHints: () => store.getRuntimeHints(name)?.hints,
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
    bindAuthority: (signal) => {
      const ref = store.lookup(name);
      return {
        ...bindInternalObservationAuthority({ sessionStore: store, ref, signal }),
        capture: async ({ flags, logPath: captureLogPath }) => {
          if (!ref) {
            throw new AppError('NO_ACTIVE_SESSION', `Session "${name}" is no longer active.`);
          }
          const session = store.requireCurrent(ref);
          const bound = await bindCaptureFor(ref.lifetime, session);
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
        },
      };
    },
  });
}

type ReplayTestSessionCleanupParams = Readonly<{
  host: HostEnvironment;
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
  platformResourceCleanup: PlatformResourceCleanup;
}>;

async function releaseUnheldSuiteRequestLease(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
}): Promise<void> {
  const { req, sessionName, sessionStore, leaseRegistry, leaseLifecycleProvider } = params;
  const admittedLease = req.internal?.admittedLease;
  const requestLease = admittedLease ? buildSessionLeaseFromRequest(req, admittedLease) : undefined;
  if (!requestLease) return;
  if (req.internal?.endedLeases?.some((entry) => entry.leaseId === requestLease.leaseId)) {
    return;
  }
  if (
    sessionStore.listRefs().some((other) => other.session.lease?.leaseId === requestLease.leaseId)
  ) {
    return;
  }
  const { endedLeaseId } = await releaseSessionLease({
    session: { name: sessionName, lease: requestLease },
    leaseRegistry,
    leaseLifecycleProvider,
  });
  if (endedLeaseId) recordEndedLease(req, endedLeaseId);
}

async function closeReplayTestSession(params: ReplayTestSessionCleanupParams): Promise<void> {
  const { req, sessionName, logPath, sessionStore } = params;
  if (!sessionStore.get(sessionName)) return;
  const suiteLeaseId = req.internal?.admittedLease?.leaseId;
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
          ...(suiteLeaseId ? { suiteLeaseId } : {}),
        },
      },
      req,
    ),
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry: params.leaseRegistry,
    leaseLifecycleProvider: params.leaseLifecycleProvider,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
    platformResourceCleanup: params.platformResourceCleanup,
  });
  if (closeResponse.ok) return;
  throw new AppError(closeResponse.error.code, closeResponse.error.message, {
    ...(closeResponse.error.details ?? {}),
    ...(closeResponse.error.hint ? { hint: closeResponse.error.hint } : {}),
  });
}
