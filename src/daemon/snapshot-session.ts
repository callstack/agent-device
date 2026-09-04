import { resolveTargetDevice } from '../core/dispatch-resolve.ts';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';
import type { DaemonRequest, SessionScope, SessionState } from './types.ts';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';
import { SessionStore } from './session-store.ts';

export async function resolveSessionDevice(
  sessionStore: SessionStore,
  sessionName: string,
  flags: DaemonRequest['flags'],
) {
  const session = sessionStore.get(sessionName);
  const device = session?.device ?? (await resolveTargetDevice(flags ?? {}));
  return { session, device };
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
  session: SessionState | undefined,
  req: DaemonRequest,
  result: Record<string, unknown>,
): void {
  if (!session) return;
  sessionStore.recordAction(session, {
    command: req.command,
    positionals: req.positionals ?? [],
    flags: req.flags ?? {},
    result,
  });
}

export function buildSnapshotSession(params: {
  session: SessionState | undefined;
  sessionName: string;
  sessionScope: SessionScope;
  device: SessionState['device'];
  snapshot: SessionState['snapshot'];
  appBundleId?: string;
}): SessionState {
  const { session, sessionName, sessionScope, device, snapshot, appBundleId } = params;
  if (session) {
    return {
      ...session,
      snapshot,
      lastComparisonSafeSnapshot:
        snapshot?.comparisonSafe === true ? snapshot : session.lastComparisonSafeSnapshot,
    };
  }
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
