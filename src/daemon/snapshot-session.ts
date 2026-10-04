import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import type { PlatformResourceCleanup } from './platform-resource-cleanup.ts';
import type { DaemonRequest } from './daemon-request.ts';
import type { SessionRef, SessionState } from './session-state.ts';
import type { SessionScope } from '@agent-device/contracts/session';
import { isActiveProviderDevice } from './provider-device-admission.ts';
import { SessionStore } from './session-store.ts';

export async function resolveSessionDevice(
  sessionStore: SessionStore,
  sessionName: string,
  flags: DaemonRequest['flags'],
  boundRef?: SessionRef,
) {
  const ref = boundRef ?? sessionStore.lookup(sessionName);
  const session = ref ? sessionStore.requireCurrent(ref) : undefined;
  const device = session?.device ?? (await resolveTargetDevice(flags ?? {}));
  return { ref, session, device };
}

export async function withSessionlessRunnerCleanup<T>(
  session: SessionState | undefined,
  device: SessionState['device'],
  task: () => Promise<T>,
  platformCleanup?: PlatformResourceCleanup,
): Promise<T> {
  if (!session && !platformCleanup) {
    throw new Error('Platform resource cleanup was not injected');
  }
  try {
    return await task();
  } finally {
    // Only a device this daemon prepared a local execution host for can have one to release. A
    // provider-owned device runs on provider infrastructure, where local teardown drives host
    // tooling at a device id this host does not own.
    if (!session && !isActiveProviderDevice(device)) {
      await platformCleanup!.cleanupSessionlessExecutionHost(device);
    }
  }
}

export function recordIfSession(
  sessionStore: SessionStore,
  ref: SessionRef | undefined,
  req: DaemonRequest,
  result: Record<string, unknown>,
): void {
  if (!ref) return;
  sessionStore.recordAction(ref, {
    command: req.command,
    positionals: req.positionals ?? [],
    flags: req.flags ?? {},
    result,
  });
}

export function createSnapshotSession(params: {
  sessionName: string;
  sessionScope: SessionScope;
  device: SessionState['device'];
  snapshot: SessionState['snapshot'];
  appBundleId?: string;
}): SessionState {
  const { sessionName, sessionScope, device, snapshot, appBundleId } = params;
  return {
    name: sessionName,
    sessionScope,
    device,
    createdAt: Date.now(),
    appBundleId,
    snapshot,
    ...(snapshot?.comparisonSafe === true ? { lastComparisonSafeSnapshot: snapshot } : {}),
    actions: [],
  };
}
