import path from 'node:path';
import type {
  DurableResourceEnvelope,
  LiveResourceHandle,
  PlatformRequestScope,
  ResourceUnreattachableReason,
} from '@agent-device/contracts/platform';
import { isConfirmedCleanup } from '@agent-device/contracts/platform';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import {
  acquireDurableCaptureRecoveryAuthorityBeforeDeadline,
  DurableCaptureRecoveryDeadlineError,
  type DurableCaptureRecoveryAuthority,
  type DurableCaptureRecoveryControl,
} from './durable-capture-recovery-authority.ts';
import {
  withDurableCaptureResourceFence,
  type DurableCaptureResourceFenceLease,
} from './durable-capture-resource-fence.ts';
import type { DurableCaptureResourceDefinition } from './durable-capture-resource.ts';
import { durableCaptureDiagnosticPrefix } from './durable-capture-resource-labels.ts';
import { transitionCleanupOutcome } from './durable-capture-resource-transitions.ts';
import { safeSessionName } from './session-paths.ts';

const DEFAULT_RECOVERY_DEADLINE_MS = 5_000;

export type DurableCaptureRecoverySummary = Readonly<{
  scanned: number;
  recovered: number;
  retained: number;
}>;

export type DurableCaptureRecoveryDiagnostic = Readonly<{
  phase: string;
  resourcePath: string;
  data: Readonly<Record<string, unknown>>;
}>;

export type DurableCaptureRecoveryParams<K extends string, H extends LiveResourceHandle<C>, C> = {
  definition: DurableCaptureResourceDefinition<K, H, C>;
  sessionsDir: string;
  scope: PlatformRequestScope;
  acquireControl(
    envelope: DurableResourceEnvelope<K>,
    scope: PlatformRequestScope,
  ): Promise<DurableCaptureRecoveryControl<K, H, C>>;
  perRecordDeadlineMs?: number;
  onDiagnostic?: (diagnostic: DurableCaptureRecoveryDiagnostic) => void;
};

export async function recoverDurableCaptureResourcesAfterDaemonLock<
  K extends string,
  H extends LiveResourceHandle<C>,
  C,
>(params: DurableCaptureRecoveryParams<K, H, C>): Promise<DurableCaptureRecoverySummary> {
  const paths = params.definition.store.list(params.sessionsDir);
  const outcomes: Array<'ignored' | 'recovered' | 'retained'> = [];
  for (const resourcePath of paths) {
    outcomes.push(await recoverResourcePath(params, resourcePath));
  }
  return {
    scanned: paths.length,
    recovered: outcomes.filter((outcome) => outcome === 'recovered').length,
    retained: outcomes.filter((outcome) => outcome === 'retained').length,
  };
}

async function recoverResourcePath<K extends string, H extends LiveResourceHandle<C>, C>(
  params: DurableCaptureRecoveryParams<K, H, C>,
  resourcePath: string,
): Promise<'ignored' | 'recovered' | 'retained'> {
  const candidate = readRecoveryCandidate(params, resourcePath);
  if (candidate.status !== 'recoverable') return candidate.status;
  try {
    const recovered = await recoverBeforeDeadline(
      params,
      resourcePath,
      candidate.envelope,
      params.perRecordDeadlineMs ?? DEFAULT_RECOVERY_DEADLINE_MS,
    );
    return recovered ? 'recovered' : 'retained';
  } catch (error) {
    report(
      params,
      error instanceof DurableCaptureRecoveryDeadlineError ? 'timed_out' : 'failed',
      resourcePath,
      {
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof DurableCaptureRecoveryDeadlineError
          ? { deadlineMs: error.deadlineMs }
          : {}),
      },
    );
    return 'retained';
  }
}

function readRecoveryCandidate<K extends string, H extends LiveResourceHandle<C>, C>(
  params: DurableCaptureRecoveryParams<K, H, C>,
  resourcePath: string,
):
  | Readonly<{ status: 'ignored' | 'retained' }>
  | Readonly<{ status: 'recoverable'; envelope: DurableResourceEnvelope<K> }> {
  const record = params.definition.store.read(resourcePath);
  if (record.status === 'unreattachable') {
    report(params, 'record_unreattachable', resourcePath, {
      reason: record.reason,
      message: record.message,
      version: record.version,
    });
    return { status: 'retained' };
  }
  if (record.status === 'missing' || record.envelope.lifecycle === 'completed') {
    return { status: 'ignored' };
  }
  const canonicalPath = params.definition.store.resolvePath(
    path.join(params.sessionsDir, safeSessionName(record.envelope.sessionId)),
  );
  if (path.resolve(resourcePath) !== path.resolve(canonicalPath)) {
    report(params, 'session_path_mismatch', resourcePath, {
      envelopeSessionId: record.envelope.sessionId,
      canonicalPath,
    });
    return { status: 'retained' };
  }
  return { status: 'recoverable', envelope: record.envelope };
}

async function recoverBeforeDeadline<K extends string, H extends LiveResourceHandle<C>, C>(
  params: DurableCaptureRecoveryParams<K, H, C>,
  resourcePath: string,
  envelope: DurableResourceEnvelope<K>,
  deadlineMs: number,
): Promise<boolean> {
  const authority = await acquireDurableCaptureRecoveryAuthorityBeforeDeadline({
    displayName: params.definition.displayName,
    envelope,
    scope: params.scope,
    deadlineMs,
    acquireControl: params.acquireControl,
    onLateCleanupFailure: (phase, cleanupError, primaryError) =>
      report(params, phase, resourcePath, {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
      }),
  });
  return await settleRecoveryAuthority(params, resourcePath, envelope, authority);
}

async function settleRecoveryAuthority<K extends string, H extends LiveResourceHandle<C>, C>(
  params: DurableCaptureRecoveryParams<K, H, C>,
  resourcePath: string,
  envelope: DurableResourceEnvelope<K>,
  authority: DurableCaptureRecoveryAuthority<K, H, C>,
): Promise<boolean> {
  try {
    switch (authority.reattached.status) {
      case 'active': {
        const handle = authority.reattached.handle;
        const cleanup = await withDurableCaptureResourceFence({
          store: params.definition.store,
          resourcePath,
          expected: envelope.fence,
          run: async (lease) => {
            markCompleting(lease);
            const outcome = await handle.forceCleanup();
            transitionCleanupOutcome(lease, outcome);
            return outcome;
          },
        });
        return isConfirmedCleanup(cleanup);
      }
      case 'completed':
        await transitionTerminal(params, resourcePath, envelope, {
          ...params.definition.completionMetadata(authority.reattached.result),
        });
        return true;
      case 'missing':
        await transitionTerminal(params, resourcePath, envelope, {
          recoveryStatus: 'already-missing',
        });
        return true;
      case 'unreattachable': {
        if (!allowsDurableCaptureDescriptorCleanup(authority.reattached.reason)) {
          report(params, 'retained', resourcePath, {
            reason: authority.reattached.reason,
            message: authority.reattached.message,
          });
          return false;
        }
        const cleanup = await authority.control.cleanup(envelope);
        await withDurableCaptureResourceFence({
          store: params.definition.store,
          resourcePath,
          expected: envelope.fence,
          run: async (lease) => transitionCleanupOutcome(lease, cleanup),
        });
        return isConfirmedCleanup(cleanup);
      }
    }
  } finally {
    await authority.control[Symbol.asyncDispose]();
  }
}

async function transitionTerminal<K extends string, H extends LiveResourceHandle<C>, C>(
  params: DurableCaptureRecoveryParams<K, H, C>,
  resourcePath: string,
  envelope: DurableResourceEnvelope<K>,
  metadata: Record<string, unknown>,
): Promise<void> {
  await withDurableCaptureResourceFence({
    store: params.definition.store,
    resourcePath,
    expected: envelope.fence,
    run: async (lease) => {
      lease.transition('completed', {
        metadata: { ...(lease.envelope.metadata ?? {}), phase: 'completed', ...metadata },
      });
    },
  });
}

function markCompleting<K extends string>(lease: DurableCaptureResourceFenceLease<K>): void {
  lease.transition('open', {
    metadata: { ...(lease.envelope.metadata ?? {}), phase: 'completing' },
  });
}

export function allowsDurableCaptureDescriptorCleanup(
  reason: ResourceUnreattachableReason,
): boolean {
  switch (reason) {
    case 'descriptor-invalid':
    case 'descriptor-version-unsupported':
    case 'ownership-fence-lost':
      return false;
    case 'owner-unavailable':
    case 'transport-not-reattachable':
      return true;
  }
}

function report<K extends string, H extends LiveResourceHandle<C>, C>(
  params: DurableCaptureRecoveryParams<K, H, C>,
  suffix: string,
  resourcePath: string,
  data: Record<string, unknown>,
): void {
  const diagnostic = {
    phase: `${durableCaptureDiagnosticPrefix(params.definition.resourceKind)}_recovery_${suffix}`,
    resourcePath,
    data,
  };
  if (params.onDiagnostic) params.onDiagnostic(diagnostic);
  else emitDiagnostic({ level: 'warn', phase: diagnostic.phase, data: { resourcePath, ...data } });
}
