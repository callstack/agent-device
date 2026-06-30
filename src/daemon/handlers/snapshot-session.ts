import { resolveTargetDevice } from '../../core/dispatch.ts';
import {
  resolveRunnerAppBundleId,
  stopIosRunnerSession,
} from '../../platforms/apple/core/runner/runner-client.ts';
import { closeIosApp } from '../../platforms/apple/core/apps.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
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
  const shouldCleanupSessionlessIosRunner = !session && device.platform === 'ios';
  try {
    return await task();
  } finally {
    // Sessionless iOS commands intentionally stop the runner to avoid leaked xcodebuild processes.
    // For multi-command flows, keep an active session via `open` so the runner can be reused.
    if (shouldCleanupSessionlessIosRunner) {
      await stopIosRunnerSession(device.id);
      await closeSessionlessIosRunnerHostApp(device);
    }
  }
}

async function closeSessionlessIosRunnerHostApp(device: SessionState['device']): Promise<void> {
  const bundleId = resolveRunnerAppBundleId();
  await closeIosApp(device, bundleId).catch((error) => {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_sessionless_runner_host_close_failed',
      data: {
        deviceId: device.id,
        bundleId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  });
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
