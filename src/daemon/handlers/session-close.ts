import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { isApplePlatform, type DeviceInfo } from '../../kernel/device.ts';
import { dispatchCommand } from '../../core/dispatch.ts';
import { contextFromFlags } from '../context.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
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
import { recordSessionAction } from './handler-utils.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import { releaseSessionLease } from '../lease-lifecycle.ts';
import type { LeaseLifecycleProvider } from './lease.ts';
import {
  stopAppleRunnerForClose,
  stopSessionAndroidNativePerfCapture,
  stopSessionAndroidSnapshotHelper,
  stopSessionAppLog,
  stopSessionApplePerfCapture,
  stopSessionAudioProbe,
} from '../session-teardown.ts';

async function maybeShutdownSessionTarget(params: {
  device: DeviceInfo;
  shutdownRequested: boolean | undefined;
}): Promise<DeviceTargetShutdownResult | undefined> {
  const { device, shutdownRequested } = params;
  if (!shutdownRequested) return undefined;
  if (!canShutdownDeviceTarget(device)) return undefined;
  return await shutdownDeviceTarget(device);
}

function shouldRetainAppleRunnerAfterClose(req: DaemonRequest, session: SessionState): boolean {
  return (
    isIosSimulator(session.device) &&
    !req.flags?.shutdown &&
    !session.recording &&
    !session.lease &&
    !session.device.simulatorSetPath
  );
}

function shouldStopAppleRunnerBeforeTargetedClose(session: SessionState): boolean {
  return isApplePlatform(session.device.platform) && !isIosSimulator(session.device);
}

export async function handleCloseCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, leaseRegistry, leaseLifecycleProvider } = params;
  const session = sessionStore.get(sessionName);
  if (!session) {
    return await closeWithoutSession(req, logPath);
  }
  let providerData: Record<string, unknown> | undefined;
  try {
    await stopSessionAppLog(session);
    await stopSessionAudioProbe(session, 'session-close');
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
    recordSessionAction(sessionStore, session, req, 'close', {
      session: session.name,
      ...successText(`Closed: ${session.name}`),
    });
    if (req.flags?.saveScript) {
      session.recordSession = true;
    }
    sessionStore.writeSessionLog(session);
    await cleanupRetainedMaterializedPathsForSession(sessionName).catch(() => {});
  } finally {
    // Always drop the local session, even if provider-side release fails:
    // a failed close must not strand device ownership until inactivity expiry.
    try {
      providerData = await releaseSessionLease({ session, leaseRegistry, leaseLifecycleProvider });
    } finally {
      sessionStore.delete(sessionName);
    }
  }
  const shutdownResult = await maybeShutdownSessionTarget({
    device: session.device,
    shutdownRequested: req.flags?.shutdown,
  });
  if (shutdownResult) {
    return {
      ok: true,
      data: withSuccessText(
        {
          session: session.name,
          shutdown: shutdownResult,
          ...(providerData ? { provider: providerData } : {}),
        },
        `Closed: ${session.name}`,
      ),
    };
  }
  return {
    ok: true,
    data: {
      session: session.name,
      ...successText(`Closed: ${session.name}`),
      ...(providerData ? { provider: providerData } : {}),
    },
  };
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
