import { isDeepLinkTarget } from '../core/open-target.ts';
import type { SessionSurface } from '../core/session-surface.ts';
import type { AppleRunnerLifecycleOptions } from '../platforms/apple/core/runner/runner-provider.ts';
import { prewarmAppleRunnerCache } from '../platforms/apple/core/runner/runner-client.ts';
import { isIosFamily, type DeviceInfo } from '../kernel/device.ts';
import { contextFromFlags } from './context.ts';
import type { DaemonRequest } from './types.ts';

export type AppleRunnerRequestOptions = Pick<
  AppleRunnerLifecycleOptions,
  | 'verbose'
  | 'logPath'
  | 'traceLogPath'
  | 'requestId'
  | 'runnerLeaseContext'
  | 'iosXctestrunFile'
  | 'iosXctestDerivedDataPath'
  | 'iosXctestEnvDir'
>;

export function buildAppleRunnerRequestOptions(params: {
  req: Pick<DaemonRequest, 'flags' | 'meta'>;
  logPath?: string;
  traceLogPath?: string;
}): AppleRunnerRequestOptions {
  const { req, logPath, traceLogPath } = params;
  return {
    verbose: req.flags?.verbose,
    logPath,
    traceLogPath,
    requestId: req.meta?.requestId,
    iosXctestrunFile: req.flags?.iosXctestrunFile,
    iosXctestDerivedDataPath: req.flags?.iosXctestDerivedDataPath,
    iosXctestEnvDir: req.flags?.iosXctestEnvDir,
  };
}

export function buildAppleRunnerSessionOptions(params: {
  req: Pick<DaemonRequest, 'flags' | 'meta'>;
  logPath: string;
  appBundleId?: string;
  traceLogPath?: string;
}): AppleRunnerRequestOptions {
  const { req, logPath, appBundleId, traceLogPath } = params;
  return {
    ...buildAppleRunnerRequestOptions({ req, logPath, traceLogPath }),
    runnerLeaseContext: contextFromFlags(
      logPath,
      req.flags,
      appBundleId,
      traceLogPath,
      req.meta?.requestId,
      req.meta,
    ).runnerLeaseContext,
  };
}

export function createAppleRunnerCachePrewarmOnColdBoot(params: {
  req: Pick<DaemonRequest, 'flags' | 'meta'>;
  logPath: string;
  device: DeviceInfo;
  traceLogPath?: string;
  enabled: boolean;
}): ((device: DeviceInfo) => void) | undefined {
  const { req, logPath, device, traceLogPath, enabled } = params;
  if (!enabled || !isIosFamily(device) || device.kind !== 'simulator') {
    return undefined;
  }
  return (bootingDevice) =>
    prewarmAppleRunnerCache(
      bootingDevice,
      buildAppleRunnerRequestOptions({ req, logPath, traceLogPath }),
    );
}

export function createAppleRunnerCacheColdBootPrewarmForOpen(params: {
  req: Pick<DaemonRequest, 'flags' | 'meta'>;
  logPath: string;
  device: DeviceInfo;
  surface: SessionSurface;
  openTarget: string | undefined;
  traceLogPath?: string;
}): ((device: DeviceInfo) => void) | undefined {
  const { req, logPath, device, surface, openTarget, traceLogPath } = params;
  return createAppleRunnerCachePrewarmOnColdBoot({
    req,
    logPath,
    device,
    traceLogPath,
    enabled: surface === 'app' && Boolean(openTarget) && !isDeepLinkTarget(openTarget ?? ''),
  });
}
