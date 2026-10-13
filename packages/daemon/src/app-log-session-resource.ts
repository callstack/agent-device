import type { LogBackend } from '@agent-device/contracts/observability';
import type { AppLogCompletion, AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type {
  ResourceOwnershipFence,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { AppLogAdmissionLedger } from './app-log-admission-ledger.ts';
import {
  createDurableCaptureResource,
  type DurableCaptureFinishIntent,
} from '@agent-device/capture-kit/durable-capture-resource';
import { appLogResourceStore } from './app-log-resource-store.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionRef, SessionState } from './session-state.ts';
import { clearAppLogFiles } from './app-log.ts';
import { bindSessionCapture } from './session-capture-binding.ts';

export type AppLogSessionSnapshot = Readonly<{
  active: boolean;
  state: 'active' | 'recovering' | 'ended' | 'failed' | 'inactive';
  backend?: LogBackend;
  startedAt?: number;
  failureCode?: string;
  failureMessage?: string;
  hint?: string;
}>;

export const appLogDurableResource = createDurableCaptureResource<
  'app-log',
  AppLogLiveHandle,
  AppLogCompletion
>({
  resourceKind: 'app-log',
  displayName: 'app-log',
  store: appLogResourceStore,
  completionMetadata: (completion) => ({
    backend: completion.backend,
    outputPath: completion.outputPath,
    completedAt: completion.completedAt,
  }),
  failedFinishPolicy: 'dispose-on-failed-finish',
  messages: {
    noActive: 'no app log stream active',
    cleanupPendingHint:
      'Keep app-log.resource.json and retry cleanup through its exact runtime owner.',
  },
});

export function inspectSessionAppLog(session: SessionState): AppLogSessionSnapshot {
  if (session.appLog) {
    const snapshot = session.appLog.handle.inspect();
    return {
      active: snapshot.state === 'active' || snapshot.state === 'recovering',
      ...snapshot,
    };
  }
  if (session.appLogFailure) {
    return {
      active: false,
      state: 'failed',
      backend: session.appLogFailure.backend,
      failureCode: session.appLogFailure.code,
      failureMessage: session.appLogFailure.message,
      hint: session.appLogFailure.hint,
    };
  }
  return { active: false, state: 'inactive' };
}

export function adoptStartedSessionAppLog(params: {
  admissionLedger: AppLogAdmissionLedger;
  ref: SessionRef;
  sessionStore: SessionStore;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  pendingHandle: PendingTransferGuard<AppLogLiveHandle>;
  envelope: DurableResourceEnvelope<'app-log'>;
  throwIfCanceled(): void;
}): Promise<void> {
  return appLogDurableResource.adoptStarted({
    ...params,
    binding: bindSessionAppLog(params.sessionStore, params.ref),
  });
}

export function finishSessionAppLog(params: {
  ref: SessionRef;
  sessionStore: SessionStore;
  intent: DurableCaptureFinishIntent;
}): Promise<AppLogCompletion> {
  return appLogDurableResource.finishLive({
    binding: bindSessionAppLog(params.sessionStore, params.ref),
    intent: params.intent,
  });
}

export function forceCleanupSessionAppLog(params: {
  ref: SessionRef;
  sessionStore: SessionStore;
}): Promise<void> {
  return appLogDurableResource.forceCleanupLive({
    binding: bindSessionAppLog(params.sessionStore, params.ref),
  });
}

export function recordSessionAppLogFailure(params: {
  ref: SessionRef;
  sessionStore: SessionStore;
  error: unknown;
  backend?: LogBackend;
}): ReturnType<typeof normalizeError> {
  const normalized = normalizeError(params.error);
  const current = params.sessionStore.resolveCurrent(params.ref);
  if (!current || current.appLog) return normalized;
  params.sessionStore.update(params.ref, {
    appLog: undefined,
    appLogFailure: {
      backend: params.backend,
      code: normalized.code,
      message: normalized.message,
      hint: normalized.hint,
    },
  });
  return normalized;
}

export function bindSessionAppLog(sessionStore: SessionStore, ref: SessionRef) {
  return bindSessionCapture(sessionStore, ref, {
    read: (session) => session.appLog,
    write: (appLog) => {
      sessionStore.update(ref, { appLog, appLogFailure: undefined });
    },
  });
}

export function clearStoppedSessionAppLog(params: { ref: SessionRef; sessionStore: SessionStore }) {
  const session = params.sessionStore.requireCurrent(params.ref);
  if (session.appLog) {
    throw new AppError(
      'INVALID_ARGS',
      'logs clear requires logs to be stopped first; run logs stop',
    );
  }
  const cleared = clearAppLogFiles(params.sessionStore.resolveAppLogPath(params.ref.address));
  params.sessionStore.update(params.ref, { appLogFailure: undefined });
  return cleared;
}
