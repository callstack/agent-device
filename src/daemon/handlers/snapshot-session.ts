import { isIosFamily } from '@agent-device/kernel/device';
import { resolveTargetDevice } from '../../core/dispatch-resolve.ts';
import { cleanupSessionlessAppleRunnerHost } from '../../platform-runtime-apple-resources.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import { SessionStore } from '../session-store.ts';

export async function resolveSessionDevice(
  sessionStore: SessionStore,
  sessionName: string,
  flags: DaemonRequest['flags'],
) {
  const session = sessionStore.get(sessionName);
  const device = session?.device ?? (await resolveTargetDevice(flags ?? {}));
  if (!session) await ensureDeviceReady(device);
  return { session, device };
}

export async function withSessionlessRunnerCleanup<T>(
  session: SessionState | undefined,
  device: SessionState['device'],
  task: () => Promise<T>,
): Promise<T> {
  const shouldCleanupSessionlessIosRunner = !session && isIosFamily(device);
  try {
    return await task();
  } finally {
    // Sessionless iOS commands intentionally stop the runner to avoid leaked xcodebuild processes.
    // For multi-command flows, keep an active session via `open` so the runner can be reused.
    if (shouldCleanupSessionlessIosRunner) {
      await cleanupSessionlessAppleRunnerHost(device);
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
  device: SessionState['device'];
  snapshot: SessionState['snapshot'];
  appBundleId?: string;
}): SessionState {
  const { session, sessionName, device, snapshot, appBundleId } = params;
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
    device,
    createdAt: Date.now(),
    appBundleId,
    snapshot,
    ...(snapshot?.comparisonSafe === true ? { lastComparisonSafeSnapshot: snapshot } : {}),
    actions: [],
  };
}
