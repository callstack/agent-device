import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { sleep } from './adb.ts';
import type { AndroidAdbExecutor } from './adb-executor.ts';
import { stopAndroidSnapshotHelperRuntime } from './snapshot-helper-retirement.ts';
import { stopAndroidSnapshotHelperSession } from './snapshot-helper-session-lifecycle.ts';

const HELPER_RUNTIME_RESET_DELAY_MS = 150;

export async function retireAndroidSnapshotHelperAfterContentFailure(params: {
  adb: AndroidAdbExecutor;
  deviceKey: string;
  packageName: string;
  signal?: AbortSignal;
  cause: unknown;
}): Promise<void> {
  const retiredPersistentSession = await stopAndroidSnapshotHelperSession(params.deviceKey, {
    // Content failure is a recovery path, not a clean release: the helper answered with output we
    // could not trust, so the next capture must meet a runtime that was reset. The session stop
    // owns that reset, so it is required here rather than layered on afterwards.
    resetRuntime: true,
    signal: params.signal,
    cause: params.cause,
  });
  params.signal?.throwIfAborted();
  if (!retiredPersistentSession) {
    // The suspect helper ran one-shot, so no session stop reset the runtime for us.
    await resetAndroidSnapshotHelperRuntime(params.adb, params.packageName);
  }
}

export async function resetAndroidSnapshotHelperRuntime(
  adb: AndroidAdbExecutor,
  packageName: string,
): Promise<void> {
  await stopAndroidSnapshotHelperRuntime({ adb, packageName });
  await sleep(HELPER_RUNTIME_RESET_DELAY_MS);
  emitDiagnostic({
    level: 'debug',
    phase: 'android_snapshot_helper_runtime_reset',
    data: { packageName },
  });
}
