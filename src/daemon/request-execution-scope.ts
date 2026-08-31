import type { CommandFlags } from '@agent-device/contracts/command';
import type { ProviderAppCatalog } from '@agent-device/contracts/device';
import type { DaemonArtifactType } from '@agent-device/kernel/contracts';
import {
  emitDiagnostic,
  getDiagnosticsMeta,
  updateDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { applyCommandDefaults } from '../cli-schema/command-schema.ts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import {
  type DaemonCommandContext,
  contextFromFlags as contextFromFlagsWithLog,
} from './context.ts';
import { assertSessionSelectorMatches } from './session-selector.ts';
import { resolveEffectiveSessionName } from './session-routing.ts';
import { scopeRequestSession } from './request-admission.ts';
import {
  admitRequestLeaseForLockedScope,
  assertLockedLeaseAdmissionPreflight,
  cleanupExpiredLeasedSession,
} from './lease-lifecycle.ts';
import { prepareLockedRequestBinding, resolveRequestExecutionLockKeys } from './request-binding.ts';
import { createRequestExecutionLocks } from './request-execution-locks.ts';
import { throwIfRequestCanceled } from '@agent-device/host-kit/request';
import { finalizeDaemonResponse } from './request-finalization.ts';
import { refreshRecordingHealth } from './request-recording-health.ts';
import {
  isHumanControlMutation,
  shouldBlockForInvalidRecording,
  shouldLockSessionExecution,
  shouldValidateSessionSelector,
} from './daemon-command-registry.ts';
import {
  buildRequestFinishedEvent,
  buildRequestStartedEvent,
  shouldRecordEventForRequest,
} from './session-event-log.ts';
import type { LeaseRegistry } from './lease-registry.ts';
import {
  resolveSessionRequestLog,
  resolveSessionRunnerLogPath,
  type SessionStore,
} from './session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { teardownSessionResources } from './session-teardown.ts';
import { finalizeBoundSessionApplicationLifecycle } from './application-lifecycle-recovery.ts';
import { runtimeHintValues } from './session-runtime.ts';
import type { DeviceRuntimeGateway } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import {
  createRequestRuntimeBindings,
  type BindDeviceRuntime,
  type BindExactDeviceRuntime,
  type InspectDeviceRuntimeFacts,
  type RequestRuntimeBindings,
} from './request-runtime-binding.ts';
import { createDeviceClaimAdmission, type DeviceClaimAdmission } from './device-claim-admission.ts';
import { createOwnerScopedDeviceClaimReconciler } from './device-claim-owner-recovery.ts';
import { resolveCommandDeviceClaimPolicy } from '../core/command-descriptor/registry.ts';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';

// Production daemon wiring owns one LeaseRegistry per process; scoping locks by registry keeps
// test and embedded routers isolated without changing process-level serialization there.
const leaseRegistryExecutionLocks = new WeakMap<LeaseRegistry, Map<string, Promise<unknown>>>();
const requestScopeFinalizers = new WeakMap<
  RequestExecutionScope,
  (response: DaemonResponse) => DaemonResponse
>();

export type RequestExecutionScope = AsyncDisposable & {
  req: DaemonRequest;
  command: string;
  sessionName: string;
  requestLogPath: string;
  runnerLogPath: string;
  startedAtMs: number;
  runAdmitted<T>(task: () => Promise<T>): Promise<T>;
  runLocked<T>(task: () => Promise<T>): Promise<T>;
  retainDeviceExecutionLock(deviceId: string): Promise<void>;
  bindDevice: BindDeviceRuntime;
  inspectFacts: InspectDeviceRuntimeFacts;
  bindExactDevice: BindExactDeviceRuntime;
  throwIfCanceled(): void;
};

export type LockedRequestScope = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  existingSession: SessionState | undefined;
  retainDeviceExecutionLock(deviceId: string): Promise<void>;
  bindDevice: BindDeviceRuntime;
  inspectFacts: InspectDeviceRuntimeFacts;
  bindExactDevice: BindExactDeviceRuntime;
  throwIfCanceled(): void;
  contextFromFlags(
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ): DaemonCommandContext;
  handlerContextFromFlags(
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ): DaemonCommandContext;
};

export type LockedRequestScopeResult =
  | { type: 'scope'; scope: LockedRequestScope }
  | { type: 'response'; response: DaemonResponse };

export async function createRequestExecutionScope(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  deviceRuntimeGateway?: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  platformRequestScope?: PlatformRequestScope;
  platformResourceCleanup?: PlatformResourceCleanup;
  providerAppCatalog?: ProviderAppCatalog;
}): Promise<RequestExecutionScope> {
  const { sessionStore, leaseRegistry } = params;
  let scopedReq = applyRequestCommandDefaults(scopeRequestSession(params.req));

  const command = scopedReq.command;
  const startedAtMs = Date.now();
  const sessionName = resolveEffectiveSessionName(scopedReq, sessionStore);
  const diagnosticsMeta = getDiagnosticsMeta();
  const sessionDir = sessionStore.resolveSessionDir(sessionName);
  const requestLog = resolveSessionRequestLog({
    sessionDir,
    session: sessionName,
    requestId: scopedReq.meta?.requestId ?? diagnosticsMeta.requestId,
  });
  const requestLogPath = requestLog.path;
  const runnerLogPath = resolveSessionRunnerLogPath(sessionDir);
  updateDiagnosticsScope({
    session: sessionName,
    logPath: requestLog.path,
    logRecord: requestLog.ref,
  });
  emitDiagnostic({
    level: 'info',
    phase: 'request_start',
    data: {
      publicSession: scopedReq.session,
      effectiveSession: sessionName,
      command: scopedReq.command,
      tenant: scopedReq.meta?.tenantId,
      isolation: scopedReq.meta?.sessionIsolation,
      requestLogPath,
      runnerLogPath,
    },
  });
  const shouldRecordRequestEvents = shouldRecordEventForRequest(scopedReq);
  if (shouldRecordRequestEvents) {
    sessionStore.recordEvent(
      sessionName,
      buildRequestStartedEvent({
        req: scopedReq,
      }),
    );
  }
  try {
    assertLockedLeaseAdmissionPreflight(scopedReq);
    const executionLockKeys = shouldLockSessionExecution(command)
      ? await resolveRequestExecutionLockKeys({ req: scopedReq, sessionName, sessionStore })
      : [];
    const executionLocks = getLeaseRegistryExecutionLocks(leaseRegistry);
    const requestExecutionLocks = createRequestExecutionLocks({
      locks: executionLocks,
      initialKeys: executionLockKeys,
    });
    const { claimAdmission, runtimeBindings } = createRequestDeviceAccess({
      command,
      workspace: scopedReq.meta?.cwd ?? process.cwd(),
      stateDir: sessionStore.resolveDaemonStateDir(),
      deviceRuntimeGateway: params.deviceRuntimeGateway,
      platformRequestScope: params.platformRequestScope,
    });

    const scope: RequestExecutionScope = {
      req: scopedReq,
      command,
      sessionName,
      requestLogPath,
      runnerLogPath,
      startedAtMs,
      retainDeviceExecutionLock: async (deviceId) =>
        await requestExecutionLocks.retainDevice(deviceId),
      bindDevice:
        runtimeBindings?.bindDevice ??
        (async () => {
          throw new AppError(
            'COMMAND_FAILED',
            'Device runtime gateway is not configured for this request scope',
            { reason: 'runtime-gateway-missing' },
          );
        }),
      inspectFacts:
        runtimeBindings?.inspectFacts ??
        (async () => {
          throw new AppError(
            'COMMAND_FAILED',
            'Device runtime gateway is not configured for this request scope',
            { reason: 'runtime-gateway-missing' },
          );
        }),
      bindExactDevice:
        runtimeBindings?.bindExactDevice ??
        (async () => {
          throw new AppError(
            'COMMAND_FAILED',
            'Device runtime gateway is not configured for this request scope',
            { reason: 'runtime-gateway-missing' },
          );
        }),
      throwIfCanceled: () => throwIfRequestCanceled(scopedReq.meta?.requestId),
      runAdmitted: async (task) => {
        throwIfRequestCanceled(scopedReq.meta?.requestId);
        await cleanupExpiredLeasedSession({
          sessionName,
          sessionStore,
          leaseRegistry,
          teardownSession: async (session, expiredSessionName) =>
            await teardownExpiredSession({
              session,
              sessionName: expiredSessionName,
              sessionStore,
              inspectFacts: scope.inspectFacts,
              bindDevice: scope.bindDevice,
              platformCleanup: requirePlatformCleanup(params.platformResourceCleanup),
            }),
        });
        scopedReq = admitRequestLeaseForLockedScope({
          req: scopedReq,
          sessionName,
          sessionStore,
          leaseRegistry,
          providerAppCatalog: params.providerAppCatalog,
        });
        scope.req = scopedReq;
        return isHumanControlMutation(scopedReq)
          ? await leaseRegistry.runDeviceMutation(scopedReq.internal?.admittedLease, task)
          : await task();
      },
      runLocked: async (task) => {
        throwIfRequestCanceled(scopedReq.meta?.requestId);
        return await requestExecutionLocks.run(async () => await scope.runAdmitted(task));
      },
      // Claims outlive the bindings they guard: release only once no device
      // operation from this request can still run.
      [Symbol.asyncDispose]: async () => {
        try {
          await runtimeBindings?.[Symbol.asyncDispose]();
        } finally {
          await claimAdmission?.[Symbol.asyncDispose]();
        }
      },
    };
    requestScopeFinalizers.set(scope, (response) => {
      if (shouldRecordRequestEvents) {
        sessionStore.recordEvent(
          sessionName,
          buildRequestFinishedEvent({
            req: scopedReq,
            response,
            durationMs: Math.max(0, Date.now() - startedAtMs),
          }),
        );
      }
      return response;
    });
    return scope;
  } catch (error) {
    if (shouldRecordRequestEvents) {
      sessionStore.recordEvent(
        sessionName,
        buildRequestFinishedEvent({
          req: scopedReq,
          response: {
            ok: false,
            error: normalizeError(error, {
              diagnosticId: getDiagnosticsMeta().diagnosticId,
              logPath: requestLogPath,
            }),
          },
          durationMs: Math.max(0, Date.now() - startedAtMs),
        }),
      );
    }
    throw error;
  }
}

/**
 * The request's device access, gated by the executing command's #1320 claim
 * policy: bindings hand out device operations only after the claim admission
 * derived from that policy allows it, so `transient-exclusive` commands hold an
 * exclusive claim for as long as they can reach a device and every other policy
 * stays out of the claim store.
 */
function createRequestDeviceAccess(params: {
  command: string;
  workspace: string;
  stateDir: string;
  deviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> | undefined;
  platformRequestScope: PlatformRequestScope | undefined;
}): {
  claimAdmission: DeviceClaimAdmission | undefined;
  runtimeBindings: RequestRuntimeBindings | undefined;
} {
  const { deviceRuntimeGateway, platformRequestScope } = params;
  if (!deviceRuntimeGateway || !platformRequestScope) {
    return { claimAdmission: undefined, runtimeBindings: undefined };
  }
  const claimAdmission = createDeviceClaimAdmission({
    policy: resolveCommandDeviceClaimPolicy(params.command),
    command: params.command,
    workspace: params.workspace,
    stateDir: params.stateDir,
    reconcileOrphanedDeviceClaim: createOwnerScopedDeviceClaimReconciler(platformRequestScope),
  });
  return {
    claimAdmission,
    runtimeBindings: createRequestRuntimeBindings({
      gateway: deviceRuntimeGateway,
      scope: platformRequestScope,
      admitDeviceClaim: claimAdmission.admit,
    }),
  };
}

async function teardownExpiredSession(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
  platformCleanup: PlatformResourceCleanup;
}): Promise<void> {
  const { session, sessionName, sessionStore, inspectFacts, bindDevice, platformCleanup } = params;
  let primaryError: unknown;
  try {
    await teardownSessionResources({
      appLog: 'run',
      session,
      sessionName,
      sessionStore,
      platformCleanup,
    });
  } catch (error) {
    primaryError = error;
  }
  try {
    await finalizeBoundSessionApplicationLifecycle({
      inspectFacts,
      bindDevice,
      session,
      stateDir: sessionStore.resolveDaemonStateDir(),
      runtimeHints: runtimeHintValues(sessionStore.getRuntimeHints(sessionName)),
    });
  } catch (cleanupError) {
    if (primaryError !== undefined) {
      emitDiagnostic({
        level: 'error',
        phase: 'expired_session_lifecycle_cleanup_failed',
        data: {
          session: sessionName,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
        },
      });
    } else {
      throw cleanupError;
    }
  }
  if (primaryError !== undefined) throw primaryError;
}

function requirePlatformCleanup(
  cleanup: PlatformResourceCleanup | undefined,
): PlatformResourceCleanup {
  if (!cleanup) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Platform resource cleanup was not supplied by root runtime composition',
    );
  }
  return cleanup;
}

function applyRequestCommandDefaults(req: DaemonRequest): DaemonRequest {
  const flags = { ...(req.flags ?? {}) };
  const changed = applyCommandDefaults(req.command, flags);
  if (!changed) return req;
  return {
    ...req,
    flags: flags as CommandFlags,
  };
}

export async function prepareLockedRequestScope(params: {
  scope: RequestExecutionScope;
  sessionStore: SessionStore;
  trackDownloadableArtifact: (opts: {
    artifactPath: string;
    tenantId?: string;
    artifactType: DaemonArtifactType | undefined;
    fileName?: string;
  }) => string;
}): Promise<LockedRequestScopeResult> {
  const { scope, sessionStore, trackDownloadableArtifact } = params;
  const logPath = scope.runnerLogPath;
  scope.throwIfCanceled();
  const seededSession = sessionStore.get(scope.sessionName);
  if (seededSession) {
    // Called under runLocked: refreshRecordingHealth may mutate session recording state.
    await refreshRecordingHealth(seededSession);
    sessionStore.set(scope.sessionName, seededSession);
  }
  const binding = prepareLockedRequestBinding({
    req: scope.req,
    sessionName: scope.sessionName,
    sessionStore,
  });
  const lockedReq = binding.req;
  // `scope.sessionName` is the resolved store key, so `existingRef` carries the address every
  // recovery producer below must name — `existingRef.session.name` is only the public name.
  const existingRef = binding.existingRef;
  const existingSession = existingRef?.session;
  updateDiagnosticsScope({ traceLogPath: existingSession?.trace?.outPath });
  const finalize = (response: DaemonResponse): DaemonResponse => {
    const finalized = finalizeDaemonResponse(lockedReq, response, trackDownloadableArtifact);
    if (shouldRecordEventForRequest(lockedReq)) {
      sessionStore.recordEvent(
        scope.sessionName,
        buildRequestFinishedEvent({
          req: lockedReq,
          response: finalized,
          durationMs: Math.max(0, Date.now() - scope.startedAtMs),
        }),
      );
    }
    return finalized;
  };
  requestScopeFinalizers.set(scope, finalize);

  const recordingInvalidatedReason =
    existingSession?.screenRecording?.handle.inspect().invalidatedReason;
  if (recordingInvalidatedReason && shouldBlockForInvalidRecording(scope.command)) {
    return {
      type: 'response',
      response: {
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message: recordingInvalidatedReason,
        },
      },
    };
  }

  if (existingRef && !lockedReq.meta?.lockPolicy && shouldValidateSessionSelector(scope.command)) {
    assertSessionSelectorMatches(existingRef, lockedReq.flags);
  }

  const contextFromFlags = (
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ): DaemonCommandContext =>
    contextFromRequestFlags(logPath, flags, appBundleId, traceLogPath, lockedReq.meta);

  return {
    type: 'scope',
    scope: {
      req: lockedReq,
      sessionName: scope.sessionName,
      logPath,
      existingSession,
      retainDeviceExecutionLock: scope.retainDeviceExecutionLock,
      bindDevice: scope.bindDevice,
      inspectFacts: scope.inspectFacts,
      bindExactDevice: scope.bindExactDevice,
      throwIfCanceled: scope.throwIfCanceled,
      contextFromFlags,
      handlerContextFromFlags: (flags, appBundleId, traceLogPath) =>
        ({
          ...contextFromFlags(flags, appBundleId, traceLogPath),
          // Handlers may update surface during the request, so read the current session state.
          surface: sessionStore.get(scope.sessionName)?.surface,
        }) satisfies DaemonCommandContext,
    },
  };
}

/** Final response/event construction runs only after request bindings dispose. */
export function finalizeRequestExecutionScope(
  scope: RequestExecutionScope,
  response: DaemonResponse,
): DaemonResponse {
  const finalize = requestScopeFinalizers.get(scope);
  requestScopeFinalizers.delete(scope);
  return finalize ? finalize(response) : response;
}

function contextFromRequestFlags(
  logPath: string,
  flags: CommandFlags | undefined,
  appBundleId?: string,
  traceLogPath?: string,
  meta?: DaemonRequest['meta'],
): DaemonCommandContext {
  const requestId = getDiagnosticsMeta().requestId;
  return {
    ...contextFromFlagsWithLog(logPath, flags, appBundleId, traceLogPath, requestId, meta),
    requestId,
  };
}

function getLeaseRegistryExecutionLocks(
  leaseRegistry: LeaseRegistry,
): Map<string, Promise<unknown>> {
  let locks = leaseRegistryExecutionLocks.get(leaseRegistry);
  if (!locks) {
    locks = new Map();
    leaseRegistryExecutionLocks.set(leaseRegistry, locks);
  }
  return locks;
}
