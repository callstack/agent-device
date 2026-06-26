import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { isApplePlatform, type DeviceInfo } from '../../utils/device.ts';
import { runMacOsAlertAction } from '../../platforms/ios/macos-helper.ts';
import { dispatchCommand } from '../../core/dispatch.ts';
import { contextFromFlags } from '../context.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { stopAppLog } from '../app-log.ts';
import { stopIosRunnerSession } from '../../platforms/ios/runner-client.ts';
import { cleanupAppleXctracePerfCapture } from '../../platforms/ios/perf-xctrace.ts';
import { cleanupAndroidNativePerfSession } from '../../platforms/android/perf.ts';
import { stopAndroidSnapshotHelperSessionForDevice } from '../../platforms/android/snapshot-helper.ts';
import { clearRuntimeHintsFromApp, hasRuntimeTransportHints } from '../runtime-hints.ts';
import { cleanupRetainedMaterializedPathsForSession } from '../materialized-path-registry.ts';
import {
  canShutdownDeviceTarget,
  shutdownDeviceTarget,
  type DeviceTargetShutdownResult,
} from '../target-shutdown.ts';
import { successText, withSuccessText } from '../../utils/success-text.ts';
import {
  IOS_SIMULATOR_POST_CLOSE_SETTLE_MS,
  isIosSimulator,
  resolveCommandDevice,
  settleIosSimulator,
} from './session-device-utils.ts';
import { errorResponse } from './response.ts';
import { LeaseRegistry } from '../lease-registry.ts';

async function maybeShutdownSessionTarget(params: {
  device: DeviceInfo;
  shutdownRequested: boolean | undefined;
}): Promise<DeviceTargetShutdownResult | undefined> {
  const { device, shutdownRequested } = params;
  if (!shutdownRequested) return undefined;
  if (!canShutdownDeviceTarget(device)) return undefined;
  return await shutdownDeviceTarget(device);
}

async function stopAppleRunnerForClose(session: SessionState): Promise<void> {
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

function shouldRetainAppleRunnerAfterClose(req: DaemonRequest, session: SessionState): boolean {
  return isIosSimulator(session.device) && !req.flags?.shutdown && !session.recording;
}

function shouldStopAppleRunnerBeforeTargetedClose(session: SessionState): boolean {
  return isApplePlatform(session.device.platform) && !isIosSimulator(session.device);
}

async function stopSessionApplePerfCapture(session: SessionState): Promise<void> {
  if (!session.applePerf?.active) return;
  await cleanupAppleXctracePerfCapture(session.applePerf.active);
  session.applePerf = { ...(session.applePerf ?? {}), active: undefined };
}

async function stopSessionAndroidNativePerfCapture(session: SessionState): Promise<void> {
  const active = session.nativePerf?.android;
  if (!active) return;
  await cleanupAndroidNativePerfSession(session.device, active);
  session.nativePerf = { ...(session.nativePerf ?? {}), android: undefined };
}

async function stopSessionAndroidSnapshotHelper(session: SessionState): Promise<void> {
  if (session.device.platform !== 'android') return;
  await stopAndroidSnapshotHelperSessionForDevice(session.device);
}

export async function teardownSessionResources(
  session: SessionState,
  sessionName: string,
): Promise<void> {
  if (session.appLog) {
    await stopAppLog(session.appLog);
  }
  await stopSessionApplePerfCapture(session);
  await stopSessionAndroidNativePerfCapture(session);
  await stopSessionAndroidSnapshotHelper(session);
  if (isApplePlatform(session.device.platform)) {
    await stopAppleRunnerForClose(session);
  }
  await cleanupRetainedMaterializedPathsForSession(sessionName).catch(() => {});
}

export async function handleCloseCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry?: LeaseRegistry;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, leaseRegistry = new LeaseRegistry() } = params;
  const session = sessionStore.get(sessionName);
  if (!session) {
    return await closeWithoutSession(req, logPath);
  }
  try {
    if (session.appLog) {
      await stopAppLog(session.appLog);
    }
    await stopSessionApplePerfCapture(session);
    await stopSessionAndroidNativePerfCapture(session);
    await stopSessionAndroidSnapshotHelper(session);
    if (shouldDispatchPlatformClose(req, session)) {
      if (shouldStopAppleRunnerBeforeTargetedClose(session)) {
        await stopAppleRunnerForClose(session);
      }
      await dispatchCommand(session.device, 'close', req.positionals ?? [], req.flags?.out, {
        ...contextFromFlags(logPath, req.flags, session.appBundleId, session.trace?.outPath),
      });
      await settleIosSimulator(session.device, IOS_SIMULATOR_POST_CLOSE_SETTLE_MS);
    }
    if (
      isApplePlatform(session.device.platform) &&
      !shouldRetainAppleRunnerAfterClose(req, session)
    ) {
      // The targeted close path stops before dispatch to avoid runner/app races.
      // Stop again here for idempotent cleanup, and keep cleanup-sensitive closes explicit.
      await stopAppleRunnerForClose(session);
    } else if (isApplePlatform(session.device.platform)) {
      emitDiagnostic({
        level: 'debug',
        phase: 'ios_runner_retained_after_close',
        data: {
          session: session.name,
          deviceId: session.device.id,
        },
      });
    }
    const runtime = sessionStore.getRuntimeHints(sessionName);
    if (hasRuntimeTransportHints(runtime) && session.appBundleId) {
      await clearRuntimeHintsFromApp({
        device: session.device,
        appId: session.appBundleId,
      }).catch(() => {});
    }
    sessionStore.recordAction(session, {
      command: 'close',
      positionals: req.positionals ?? [],
      flags: req.flags ?? {},
      result: { session: session.name, ...successText(`Closed: ${session.name}`) },
    });
    if (req.flags?.saveScript) {
      session.recordSession = true;
    }
    sessionStore.writeSessionLog(session);
    await cleanupRetainedMaterializedPathsForSession(sessionName).catch(() => {});
  } finally {
    // Always release the device lease and drop the session, even if teardown
    // above threw: a failed close must not strand device ownership until the
    // inactivity expiry. The original error still propagates after finally.
    releaseSessionLease(session, leaseRegistry);
    sessionStore.delete(sessionName);
  }
  const shutdownResult = await maybeShutdownSessionTarget({
    device: session.device,
    shutdownRequested: req.flags?.shutdown,
  });
  if (shutdownResult) {
    return {
      ok: true,
      data: withSuccessText(
        { session: session.name, shutdown: shutdownResult },
        `Closed: ${session.name}`,
      ),
    };
  }
  return { ok: true, data: { session: session.name, ...successText(`Closed: ${session.name}`) } };
}

function releaseSessionLease(session: SessionState, leaseRegistry: LeaseRegistry): void {
  const lease = session.lease;
  if (!lease) return;
  const result = leaseRegistry.releaseLease({
    leaseId: lease.leaseId,
    tenantId: lease.tenantId,
    runId: lease.runId,
    backend: lease.leaseBackend,
    leaseProvider: lease.leaseProvider,
    deviceKey: lease.deviceKey,
    clientId: lease.clientId,
  });
  emitDiagnostic({
    level: 'info',
    phase: 'session_lease_released',
    data: {
      session: session.name,
      leaseId: lease.leaseId,
      released: result.released,
    },
  });
}

function shouldDispatchPlatformClose(req: DaemonRequest, session: SessionState): boolean {
  return hasCloseTarget(req) || session.device.platform === 'web';
}

function hasCloseTarget(req: DaemonRequest): boolean {
  return (req.positionals?.length ?? 0) > 0;
}

async function closeWithoutSession(req: DaemonRequest, logPath: string): Promise<DaemonResponse> {
  if (!req.positionals || req.positionals.length === 0) {
    return errorResponse('SESSION_NOT_FOUND', 'No active session');
  }
  const device = await resolveCommandDevice({
    session: undefined,
    flags: req.flags,
    ensureReady: true,
  });
  await dispatchCommand(device, 'close', req.positionals, req.flags?.out, {
    ...contextFromFlags(logPath, req.flags),
  });
  await settleIosSimulator(device, IOS_SIMULATOR_POST_CLOSE_SETTLE_MS);
  return {
    ok: true,
    data: {
      app: req.positionals[0],
      ...successText(`Closed: ${req.positionals[0]}`),
    },
  };
}
