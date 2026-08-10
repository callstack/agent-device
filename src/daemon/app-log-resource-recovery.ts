import path from 'node:path';
import {
  isConfirmedCleanup,
  narrowDeviceBinding,
  runtimeUse,
  type AppLogRuntimeOperations,
  type AppLogCompletion,
  type AppLogLiveHandle,
  type CleanupOutcome,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type DurableResourceEnvelope,
  type PlatformRequestScope,
  type ReattachOutcome,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { withAppLogResourceFence } from './app-log-resource-fence.ts';
import {
  listAppLogResourcePaths,
  readAppLogResourceRecord,
  resolveAppLogResourcePath,
} from './app-log-resource-store.ts';
import { safeSessionName } from './session-paths.ts';

const appLogRecoveryUse = runtimeUse<AppLogRuntimeOperations>()({
  required: ['appLogReattach', 'appLogCleanup'],
});

const DEFAULT_APP_LOG_RECOVERY_DEADLINE_MS = 5_000;

export type AppLogRecoverySummary = Readonly<{
  scanned: number;
  recovered: number;
  retained: number;
}>;

export type AppLogRecoveryDiagnostic = Readonly<{
  phase: string;
  resourcePath: string;
  data: Readonly<Record<string, unknown>>;
}>;

type AppLogRecoveryParams = {
  sessionsDir: string;
  gateway: DeviceRuntimeGateway<AppLogRuntimeOperations>;
  scope: PlatformRequestScope;
  perRecordDeadlineMs?: number;
  onDiagnostic?: (diagnostic: AppLogRecoveryDiagnostic) => void;
};

type AppLogRecoveryPathOutcome = 'ignored' | 'recovered' | 'retained';

/**
 * Recovers only persisted app-log resources and never creates SessionState.
 * The caller must own the daemon lock for the entire invocation.
 */
export async function recoverAppLogResourcesAfterDaemonLock(
  params: AppLogRecoveryParams,
): Promise<AppLogRecoverySummary> {
  const paths = listAppLogResourcePaths(params.sessionsDir);
  const outcomes: AppLogRecoveryPathOutcome[] = [];
  for (const resourcePath of paths) {
    outcomes.push(await recoverAppLogResourcePath(params, resourcePath));
  }
  return {
    scanned: paths.length,
    recovered: outcomes.filter((outcome) => outcome === 'recovered').length,
    retained: outcomes.filter((outcome) => outcome === 'retained').length,
  };
}

async function recoverAppLogResourcePath(
  params: AppLogRecoveryParams,
  resourcePath: string,
): Promise<AppLogRecoveryPathOutcome> {
  const record = readAppLogResourceRecord(resourcePath);
  if (record.status === 'unreattachable') {
    emitRecoveryDiagnostic(
      'app_log_recovery_record_unreattachable',
      resourcePath,
      { reason: record.reason, message: record.message, version: record.version },
      params.onDiagnostic,
    );
    return 'retained';
  }
  if (record.status === 'missing') return 'ignored';
  const canonicalResourcePath = canonicalAppLogResourcePath(
    params.sessionsDir,
    record.envelope.sessionId,
  );
  if (path.resolve(resourcePath) !== path.resolve(canonicalResourcePath)) {
    emitRecoveryDiagnostic(
      'app_log_recovery_session_path_mismatch',
      resourcePath,
      { envelopeSessionId: record.envelope.sessionId, canonicalResourcePath },
      params.onDiagnostic,
    );
    return 'retained';
  }
  if (record.envelope.lifecycle === 'completed') return 'ignored';
  return await recoverDecodedAppLogResource(params, resourcePath, record.envelope);
}

async function recoverDecodedAppLogResource(
  params: AppLogRecoveryParams,
  resourcePath: string,
  envelope: DurableResourceEnvelope<'app-log'>,
): Promise<AppLogRecoveryPathOutcome> {
  try {
    const recovered = await recoverOneBeforeDeadline({
      resourcePath,
      envelope,
      gateway: params.gateway,
      scope: params.scope,
      deadlineMs: params.perRecordDeadlineMs ?? DEFAULT_APP_LOG_RECOVERY_DEADLINE_MS,
      onDiagnostic: params.onDiagnostic,
    });
    return recovered ? 'recovered' : 'retained';
  } catch (error) {
    emitRecoveryFailure(resourcePath, error, params.onDiagnostic);
    return 'retained';
  }
}

function canonicalAppLogResourcePath(sessionsDir: string, sessionId: string): string {
  return resolveAppLogResourcePath(path.join(sessionsDir, safeSessionName(sessionId)));
}

function emitRecoveryFailure(
  resourcePath: string,
  error: unknown,
  onDiagnostic?: (diagnostic: AppLogRecoveryDiagnostic) => void,
): void {
  emitRecoveryDiagnostic(
    error instanceof AppLogRecoveryDeadlineError
      ? 'app_log_recovery_timed_out'
      : 'app_log_recovery_failed',
    resourcePath,
    {
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof AppLogRecoveryDeadlineError ? { deadlineMs: error.deadlineMs } : {}),
    },
    onDiagnostic,
  );
}

class AppLogRecoveryDeadlineError extends Error {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(`App-log recovery exceeded its ${deadlineMs}ms deadline`);
    this.name = 'AppLogRecoveryDeadlineError';
    this.deadlineMs = deadlineMs;
  }
}

async function recoverOneBeforeDeadline(params: {
  resourcePath: string;
  envelope: DurableResourceEnvelope<'app-log'>;
  gateway: DeviceRuntimeGateway<AppLogRuntimeOperations>;
  scope: PlatformRequestScope;
  deadlineMs: number;
  onDiagnostic?: (diagnostic: AppLogRecoveryDiagnostic) => void;
}): Promise<boolean> {
  const deadlineController = new AbortController();
  const scope: PlatformRequestScope = {
    ...params.scope,
    signal: AbortSignal.any([params.scope.signal, deadlineController.signal]),
  };
  let rejectDeadline: (error: AppLogRecoveryDeadlineError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    const error = new AppLogRecoveryDeadlineError(params.deadlineMs);
    deadlineController.abort(error);
    rejectDeadline(error);
  }, params.deadlineMs);
  timer.unref?.();

  const acquisition = acquireRecoveryAuthority({ ...params, scope });
  let acquired: AppLogRecoveryAuthority;
  try {
    acquired = await Promise.race([acquisition, deadline]);
  } finally {
    clearTimeout(timer);
    // A runtime that ignores cancellation is quarantined here. Acquisition checks
    // the aborted request scope before returning any authority to clean or persist.
    void acquisition.catch(() => {});
  }

  // Once exact-owner authority is acquired, settle its bounded cleanup before the
  // daemon lock may be released. The deadline intentionally no longer races this phase.
  return settleRecoveryAuthority({ ...params, ...acquired });
}

type AppLogRecoveryAuthority = Readonly<{
  binding: DeviceBinding<AppLogRuntimeOperations>;
  reattached: ReattachOutcome<AppLogLiveHandle, AppLogCompletion>;
}>;

async function acquireRecoveryAuthority(params: {
  resourcePath: string;
  envelope: DurableResourceEnvelope<'app-log'>;
  gateway: DeviceRuntimeGateway<AppLogRuntimeOperations>;
  scope: PlatformRequestScope;
  onDiagnostic?: (diagnostic: AppLogRecoveryDiagnostic) => void;
}): Promise<AppLogRecoveryAuthority> {
  let binding: DeviceBinding<AppLogRuntimeOperations> | undefined;
  let reattached: ReattachOutcome<AppLogLiveHandle, AppLogCompletion> | undefined;
  try {
    binding = await params.gateway.bind({
      device: deviceFromEnvelope(params.envelope),
      intent: {
        kind: 'exact-owner',
        owner: params.envelope.owner,
        fence: params.envelope.fence,
      },
      scope: params.scope,
    });
    params.scope.signal.throwIfAborted();
    const runtime = narrowDeviceBinding(binding, appLogRecoveryUse);
    reattached = await runtime.operations.appLogReattach({ envelope: params.envelope });
    params.scope.signal.throwIfAborted();
    return { binding, reattached };
  } catch (error) {
    await disposeAbortedRecoveryAuthority(params, error, binding, reattached);
    throw error;
  }
}

async function disposeAbortedRecoveryAuthority(
  params: Pick<Parameters<typeof acquireRecoveryAuthority>[0], 'resourcePath' | 'onDiagnostic'>,
  primaryError: unknown,
  binding: DeviceBinding<AppLogRuntimeOperations> | undefined,
  reattached: ReattachOutcome<AppLogLiveHandle, AppLogCompletion> | undefined,
): Promise<void> {
  if (reattached?.status === 'active') {
    await disposeRecoveryValue(
      reattached.handle,
      'app_log_recovery_late_handle_cleanup_failed',
      params,
      primaryError,
    );
  }
  if (binding) {
    await disposeRecoveryValue(
      binding,
      'app_log_recovery_late_binding_cleanup_failed',
      params,
      primaryError,
    );
  }
}

async function disposeRecoveryValue(
  value: AsyncDisposable,
  phase: string,
  params: Pick<Parameters<typeof acquireRecoveryAuthority>[0], 'resourcePath' | 'onDiagnostic'>,
  primaryError: unknown,
): Promise<void> {
  try {
    await value[Symbol.asyncDispose]();
  } catch (cleanupError) {
    emitRecoveryDiagnostic(
      phase,
      params.resourcePath,
      {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
      },
      params.onDiagnostic,
    );
  }
}

async function settleRecoveryAuthority(params: {
  resourcePath: string;
  envelope: DurableResourceEnvelope<'app-log'>;
  binding: DeviceBinding<AppLogRuntimeOperations>;
  reattached: ReattachOutcome<AppLogLiveHandle, AppLogCompletion>;
  onDiagnostic?: (diagnostic: AppLogRecoveryDiagnostic) => void;
}): Promise<boolean> {
  try {
    const runtime = narrowDeviceBinding(params.binding, appLogRecoveryUse);
    const { reattached } = params;
    switch (reattached.status) {
      case 'active': {
        const cleanup = await withAppLogResourceFence({
          resourcePath: params.resourcePath,
          expected: params.envelope.fence,
          run: async (lease) => {
            lease.transition('open', {
              metadata: { ...(lease.envelope.metadata ?? {}), phase: 'completing' },
            });
            const outcome = await reattached.handle.forceCleanup();
            transitionCleanupOutcome(lease, outcome);
            return outcome;
          },
        });
        return isConfirmedCleanup(cleanup);
      }
      case 'completed':
        await transitionRecoveredTerminal(params, {
          backend: reattached.result.backend,
          outputPath: reattached.result.outputPath,
          completedAt: reattached.result.completedAt,
        });
        return true;
      case 'missing':
        await transitionRecoveredTerminal(params, { recoveryStatus: 'already-missing' });
        return true;
      case 'unreattachable': {
        if (
          reattached.reason === 'descriptor-invalid' ||
          reattached.reason === 'descriptor-version-unsupported' ||
          reattached.reason === 'ownership-fence-lost'
        ) {
          emitRecoveryDiagnostic(
            'app_log_recovery_retained',
            params.resourcePath,
            { reason: reattached.reason, message: reattached.message },
            params.onDiagnostic,
          );
          return false;
        }
        const cleanup = await runtime.operations.appLogCleanup({ envelope: params.envelope });
        await withAppLogResourceFence({
          resourcePath: params.resourcePath,
          expected: params.envelope.fence,
          run: async (lease) => transitionCleanupOutcome(lease, cleanup),
        });
        return isConfirmedCleanup(cleanup);
      }
    }
  } finally {
    await params.binding[Symbol.asyncDispose]();
  }
}

async function transitionRecoveredTerminal(
  params: {
    resourcePath: string;
    envelope: DurableResourceEnvelope<'app-log'>;
  },
  metadata: Record<string, string | number>,
): Promise<void> {
  await withAppLogResourceFence({
    resourcePath: params.resourcePath,
    expected: params.envelope.fence,
    run: async (lease) => {
      lease.transition('completed', {
        metadata: { ...(lease.envelope.metadata ?? {}), phase: 'completed', ...metadata },
      });
    },
  });
}

function transitionCleanupOutcome(
  lease: Parameters<Parameters<typeof withAppLogResourceFence>[0]['run']>[0],
  outcome: CleanupOutcome,
): void {
  lease.transition(isConfirmedCleanup(outcome) ? 'completed' : 'open', {
    metadata: {
      ...(lease.envelope.metadata ?? {}),
      phase: isConfirmedCleanup(outcome) ? 'completed' : 'cleanup-pending',
      cleanupStatus: outcome.status,
      ...(outcome.status === 'cleanup-pending'
        ? {
            cleanupPendingReason: outcome.reason,
            ...(outcome.message ? { cleanupPendingMessage: outcome.message } : {}),
          }
        : {}),
    },
  });
}

function deviceFromEnvelope(envelope: DurableResourceEnvelope<'app-log'>): DeviceInfo {
  return {
    platform: envelope.device.family,
    id: envelope.device.id,
    name: envelope.device.id,
    kind: envelope.device.kind,
    ...(envelope.device.target === undefined ? {} : { target: envelope.device.target }),
    ...(envelope.device.appleOs === undefined ? {} : { appleOs: envelope.device.appleOs }),
    ...(envelope.device.iosPhysicalDeviceBackend === undefined
      ? {}
      : { iosPhysicalDeviceBackend: envelope.device.iosPhysicalDeviceBackend }),
  };
}

function emitRecoveryDiagnostic(
  phase: string,
  resourcePath: string,
  data: Record<string, unknown>,
  onDiagnostic?: (diagnostic: AppLogRecoveryDiagnostic) => void,
): void {
  if (onDiagnostic) {
    onDiagnostic({ phase, resourcePath, data });
    return;
  }
  emitDiagnostic({
    level: 'warn',
    phase,
    data: { resourcePath, ...data },
  });
}
