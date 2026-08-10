import { normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { sleep } from './adb.ts';
import type { AndroidAdbExecutor } from './adb-executor.ts';
import { stopAndroidSnapshotHelperSession } from './snapshot-helper-session.ts';

const HELPER_RUNTIME_RESET_DELAY_MS = 150;
const HELPER_RUNTIME_RESET_TIMEOUT_MS = 2_000;

export async function retireAndroidSnapshotHelperAfterContentFailure(params: {
  adb: AndroidAdbExecutor;
  deviceKey: string;
  packageName: string;
  signal?: AbortSignal;
  cause: unknown;
}): Promise<void> {
  const retiredPersistentSession = await stopAndroidSnapshotHelperSession(params.deviceKey, {
    signal: params.signal,
    cause: params.cause,
  });
  params.signal?.throwIfAborted();
  if (!retiredPersistentSession) {
    await resetAndroidSnapshotHelperRuntime(params.adb, params.packageName);
  }
}

export async function resetAndroidSnapshotHelperRuntime(
  adb: AndroidAdbExecutor,
  packageName: string,
): Promise<void> {
  try {
    await adb(['shell', 'am', 'force-stop', packageName], {
      allowFailure: true,
      timeoutMs: HELPER_RUNTIME_RESET_TIMEOUT_MS,
    });
    await sleep(HELPER_RUNTIME_RESET_DELAY_MS);
    emitDiagnostic({
      level: 'debug',
      phase: 'android_snapshot_helper_runtime_reset',
      data: { packageName },
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_helper_runtime_reset_failed',
      data: { packageName, error: normalizeError(error).message },
    });
  }
}
