import { isDeepLinkTarget } from '../../contracts/open-target.ts';
import { dispatchCommand } from '../../core/dispatch.ts';
import { isIosFamily, type DeviceInfo } from '../../kernel/device.ts';
import type { DaemonRequest, SessionRuntimeHints } from '../types.ts';
import { contextFromFlags } from '../context.ts';

type SessionOpenLaunchPlan = {
  openPositionals: string[];
  followUpLaunchUrl?: string;
  supportsTerminateRunningApp: boolean;
};

export function buildSessionOpenLaunchPlan(params: {
  device: DeviceInfo;
  openPositionals: string[];
  runtime: SessionRuntimeHints | undefined;
  flags: DaemonRequest['flags'];
}): SessionOpenLaunchPlan {
  const { device, openPositionals, runtime, flags } = params;
  const launchUrl = runtime?.launchUrl;
  if (!launchUrl || openPositionals.length !== 1) {
    return {
      openPositionals,
      supportsTerminateRunningApp:
        openPositionals.length === 2 ||
        (openPositionals.length === 1 && !isDeepLinkTarget(openPositionals[0] ?? '')),
    };
  }
  const openTarget = openPositionals[0]?.trim();
  if (!openTarget || isDeepLinkTarget(openTarget)) {
    return { openPositionals, supportsTerminateRunningApp: false };
  }

  const hasDirectLaunchOptions =
    Boolean(flags?.launchConsole?.trim()) || Boolean(flags?.launchArgs?.length);
  if (isIosFamily(device) && !hasDirectLaunchOptions) {
    return {
      openPositionals: [openTarget, launchUrl],
      supportsTerminateRunningApp: true,
    };
  }
  return {
    openPositionals,
    followUpLaunchUrl: launchUrl,
    supportsTerminateRunningApp: true,
  };
}

export async function dispatchSessionOpenFollowUpLaunchUrl(params: {
  launchUrl: string | undefined;
  device: DeviceInfo;
  req: DaemonRequest;
  logPath: string;
  appBundleId?: string;
  traceLogPath?: string;
}): Promise<void> {
  const { launchUrl, device, req, logPath, appBundleId, traceLogPath } = params;
  if (!launchUrl) return;
  const context = contextFromFlags(logPath, req.flags, appBundleId, traceLogPath);
  delete context.launchConsole;
  delete context.launchArgs;
  await dispatchCommand(device, 'open', [launchUrl], req.flags?.out, context);
}
