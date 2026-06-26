import type { CommandFlags } from '../core/dispatch.ts';
import { withKeyedLock } from '../utils/keyed-lock.ts';
import {
  emitDiagnostic,
  getDiagnosticsMeta,
  updateDiagnosticsScope,
} from '../utils/diagnostics.ts';
import { applyCommandDefaults } from '../utils/command-schema.ts';
import type { DaemonCommandContext } from './context.ts';
import { contextFromFlags as contextFromFlagsWithLog } from './context.ts';
import { assertSessionSelectorMatches } from './session-selector.ts';
import { resolveEffectiveSessionName } from './session-routing.ts';
import {
  assertRequestLeaseAdmission,
  assertRequestLeaseAdmissionPreflight,
  scopeRequestSession,
} from './request-admission.ts';
import {
  prepareLockedRequestBinding,
  resolveRequestExecutionLockKeys,
  type RequestExecutionLockKey,
} from './request-binding.ts';
import { throwIfRequestCanceled } from './request-cancel.ts';
import { finalizeDaemonResponse } from './request-finalization.ts';
import { refreshRecordingHealth } from './request-recording-health.ts';
import {
  shouldBlockForInvalidRecording,
  shouldLockSessionExecution,
  shouldValidateSessionSelector,
} from './daemon-command-registry.ts';
import type { LeaseRegistry } from './lease-registry.ts';
import {
  resolveSessionRequestLogPath,
  resolveSessionRunnerLogPath,
  type SessionStore,
} from './session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { teardownSessionResources } from './handlers/session-close.ts';

// Production daemon wiring owns one LeaseRegistry per process; scoping locks by registry keeps
// test and embedded routers isolated without changing process-level serialization there.
const leaseRegistryExecutionLocks = new WeakMap<LeaseRegistry, Map<string, Promise<unknown>>>();

export type RequestExecutionScope = {
  req: DaemonRequest;
  command: string;
  sessionName: string;
  requestLogPath: string;
  runnerLogPath: string;
  runAdmitted<T>(task: () => Promise<T>): Promise<T>;
  runLocked<T>(task: () => Promise<T>): Promise<T>;
  throwIfCanceled(): void;
};

export type LockedRequestScope = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  existingSession: SessionState | undefined;
  finalize(response: DaemonResponse): DaemonResponse;
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
}): Promise<RequestExecutionScope> {
  const { sessionStore, leaseRegistry } = params;
  let scopedReq = applyRequestCommandDefaults(scopeRequestSession(params.req));

  const command = scopedReq.command;
  const sessionName = resolveEffectiveSessionName(scopedReq, sessionStore);
  const diagnosticsMeta = getDiagnosticsMeta();
  const sessionDir = sessionStore.resolveSessionDir(sessionName);
  const requestLogPath = resolveSessionRequestLogPath(
    sessionDir,
    scopedReq.meta?.requestId ?? diagnosticsMeta.requestId,
  );
  const runnerLogPath = resolveSessionRunnerLogPath(sessionDir);
  updateDiagnosticsScope({
    session: sessionName,
    logPath: requestLogPath,
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
  assertRequestLeaseAdmissionPreflight(scopedReq);
  const executionLockKeys = shouldLockSessionExecution(command)
    ? await resolveRequestExecutionLockKeys({ req: scopedReq, sessionName, sessionStore })
    : [];
  const executionLocks = getLeaseRegistryExecutionLocks(leaseRegistry);

  const scope: RequestExecutionScope = {
    req: scopedReq,
    command,
    sessionName,
    requestLogPath,
    runnerLogPath,
    throwIfCanceled: () => throwIfRequestCanceled(scopedReq.meta?.requestId),
    runAdmitted: async (task) => {
      throwIfRequestCanceled(scopedReq.meta?.requestId);
      await cleanupExpiredLeasedSession({ sessionName, sessionStore, leaseRegistry });
      scopedReq = admitRequestLeaseForLockedScope({
        req: scopedReq,
        sessionName,
        sessionStore,
        leaseRegistry,
      });
      scope.req = scopedReq;
      return await task();
    },
    runLocked: async (task) => {
      throwIfRequestCanceled(scopedReq.meta?.requestId);
      if (executionLockKeys.length === 0) return await scope.runAdmitted(task);
      return await withRequestExecutionLocks(
        executionLocks,
        executionLockKeys,
        async () => await scope.runAdmitted(task),
      );
    },
  };
  return scope;
}

function admitRequestLeaseForLockedScope(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
}): DaemonRequest {
  const { sessionName, sessionStore, leaseRegistry } = params;
  const existingSession = sessionStore.get(sessionName);
  const activeLease = assertRequestLeaseAdmission(params.req, leaseRegistry, existingSession);
  if (!activeLease) return params.req;

  const nextReq = {
    ...params.req,
    internal: {
      ...params.req.internal,
      admittedLease: activeLease,
    },
  };
  if (existingSession?.lease) {
    sessionStore.set(sessionName, {
      ...existingSession,
      lease: {
        ...existingSession.lease,
        leaseBackend: activeLease.backend,
        expiresAt: activeLease.expiresAt,
      },
    });
  }
  return nextReq;
}

async function cleanupExpiredLeasedSession(params: {
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
}): Promise<boolean> {
  const session = params.sessionStore.get(params.sessionName);
  const lease = session?.lease;
  if (!session || !lease) return false;
  const expiredLease = params.leaseRegistry.consumeExpiredLease(lease.leaseId);
  if (!expiredLease) return false;
  emitDiagnostic({
    level: 'info',
    phase: 'leased_session_expired',
    data: {
      reason: 'LEASE_EXPIRED',
      leaseId: lease.leaseId,
      session: session.name,
      deviceKey: lease.deviceKey,
    },
  });
  await teardownSessionResources(session, session.name).catch((error) => {
    emitDiagnostic({
      level: 'debug',
      phase: 'leased_session_expiry_cleanup_failed',
      data: {
        reason: 'LEASE_EXPIRED',
        leaseId: lease.leaseId,
        session: session.name,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  });
  params.sessionStore.delete(session.name);
  return true;
}

async function withRequestExecutionLocks<T>(
  locks: Map<string, Promise<unknown>>,
  keys: RequestExecutionLockKey[],
  task: () => Promise<T>,
): Promise<T> {
  const [key, ...remainingKeys] = keys;
  if (!key) return await task();
  return await withKeyedLock(
    locks,
    key,
    async () => await withRequestExecutionLocks(locks, remainingKeys, task),
  );
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

export function prepareLockedRequestScope(params: {
  scope: RequestExecutionScope;
  sessionStore: SessionStore;
  trackDownloadableArtifact: (opts: {
    artifactPath: string;
    tenantId?: string;
    fileName?: string;
  }) => string;
}): LockedRequestScopeResult {
  const { scope, sessionStore, trackDownloadableArtifact } = params;
  const logPath = scope.runnerLogPath;
  scope.throwIfCanceled();
  let existingSession = sessionStore.get(scope.sessionName);
  if (existingSession) {
    // Called under runLocked: refreshRecordingHealth may mutate session recording state.
    refreshRecordingHealth(existingSession);
    sessionStore.set(scope.sessionName, existingSession);
  }
  const binding = prepareLockedRequestBinding({
    req: scope.req,
    sessionName: scope.sessionName,
    sessionStore,
  });
  const lockedReq = binding.req;
  existingSession = binding.existingSession;
  const finalize = (response: DaemonResponse): DaemonResponse =>
    finalizeDaemonResponse(lockedReq, response, trackDownloadableArtifact);

  if (
    existingSession?.recording?.invalidatedReason &&
    shouldBlockForInvalidRecording(scope.command)
  ) {
    return {
      type: 'response',
      response: finalize({
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message: existingSession.recording.invalidatedReason,
        },
      }),
    };
  }

  if (
    existingSession &&
    !lockedReq.meta?.lockPolicy &&
    shouldValidateSessionSelector(scope.command)
  ) {
    assertSessionSelectorMatches(existingSession, lockedReq.flags);
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
      finalize,
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
