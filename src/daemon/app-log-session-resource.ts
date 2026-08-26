import type { LogBackend } from '@agent-device/contracts/observability';
import type { AppLogCompletion, AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type {
  ResourceOwnershipFence,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import type { AppLogAdmissionLedger } from './app-log-admission-ledger.ts';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import { appLogResourceStore } from './app-log-resource-store.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';

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
  sessionSlot: {
    read: (session) => session.appLog,
    replace: (session, appLog) => ({ ...session, appLog, appLogFailure: undefined }),
  },
  completionMetadata: (completion) => ({
    backend: completion.backend,
    outputPath: completion.outputPath,
    completedAt: completion.completedAt,
  }),
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
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  resourcePath: string;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  pendingHandle: PendingTransferGuard<AppLogLiveHandle>;
  envelope: DurableResourceEnvelope<'app-log'>;
  throwIfCanceled(): void;
}): Promise<void> {
  return appLogDurableResource.adoptStarted(params);
}

export function finishSessionAppLog(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  resourcePath: string;
}): Promise<AppLogCompletion> {
  return appLogDurableResource.finishLive(params);
}

export function forceCleanupSessionAppLog(params: {
  session: SessionState;
  sessionName?: string;
  sessionStore?: SessionStore;
  resourcePath: string;
}): Promise<void> {
  return appLogDurableResource.forceCleanupLive(params);
}

export function recordSessionAppLogFailure(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  error: unknown;
  backend?: LogBackend;
}): ReturnType<typeof normalizeError> {
  const normalized = normalizeError(params.error);
  params.sessionStore.set(params.sessionName, {
    ...params.session,
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

export function clearSessionAppLogFailure(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
}): void {
  params.sessionStore.set(params.sessionName, {
    ...params.session,
    appLogFailure: undefined,
  });
}
