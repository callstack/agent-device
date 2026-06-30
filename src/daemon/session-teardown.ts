import { emitDiagnostic } from '../utils/diagnostics.ts';
import { isApplePlatform } from '../kernel/device.ts';
import { runMacOsAlertAction } from '../platforms/apple/os/macos/helper.ts';
import { stopAppLog } from './app-log.ts';
import { stopIosRunnerSession } from '../platforms/apple/core/runner/runner-client.ts';
import { cleanupAppleXctracePerfCapture } from '../platforms/apple/core/perf-xctrace.ts';
import { cleanupAndroidNativePerfSession } from '../platforms/android/perf.ts';
import { stopAndroidSnapshotHelperSessionForDevice } from '../platforms/android/snapshot-helper.ts';
import { cleanupRetainedMaterializedPathsForSession } from './materialized-path-registry.ts';
import type { SessionState } from './types.ts';

export async function stopAppleRunnerForClose(session: SessionState): Promise<void> {
  await stopIosRunnerSession(session.device.id);
  if (session.device.platform !== 'macos') {
    return;
  }

  const dismissOptions =
    session.surface === 'frontmost-app'
      ? { surface: 'frontmost-app' as const }
      : session.appBundleId
        ? { bundleId: session.appBundleId }
        : {};
  await runMacOsAlertAction('dismiss', dismissOptions).catch((error) => {
    emitDiagnostic({
      level: 'debug',
      phase: 'macos_close_alert_dismiss_failed',
      data: {
        session: session.name,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  });
}

export async function stopSessionAppLog(session: SessionState): Promise<void> {
  if (!session.appLog) return;
  await stopAppLog(session.appLog);
}

export async function stopSessionApplePerfCapture(session: SessionState): Promise<void> {
  if (!session.applePerf?.active) return;
  await cleanupAppleXctracePerfCapture(session.applePerf.active);
  session.applePerf = { ...(session.applePerf ?? {}), active: undefined };
}

export async function stopSessionAndroidNativePerfCapture(session: SessionState): Promise<void> {
  const active = session.nativePerf?.android;
  if (!active) return;
  await cleanupAndroidNativePerfSession(session.device, active);
  session.nativePerf = { ...(session.nativePerf ?? {}), android: undefined };
}

export async function stopSessionAndroidSnapshotHelper(session: SessionState): Promise<void> {
  if (session.device.platform !== 'android') return;
  await stopAndroidSnapshotHelperSessionForDevice(session.device);
}

export async function teardownSessionResources(
  session: SessionState,
  sessionName: string,
): Promise<void> {
  await stopSessionAppLog(session);
  await stopSessionApplePerfCapture(session);
  await stopSessionAndroidNativePerfCapture(session);
  await stopSessionAndroidSnapshotHelper(session);
  if (isApplePlatform(session.device.platform)) {
    await stopAppleRunnerForClose(session);
  }
  await cleanupRetainedMaterializedPathsForSession(sessionName).catch(() => {});
}
