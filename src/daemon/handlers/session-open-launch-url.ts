import { isDeepLinkTarget } from '../../contracts/open-target.ts';
import { dispatchCommand } from '../../core/dispatch.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { DaemonRequest, SessionRuntimeHints } from '../types.ts';
import { contextFromFlags } from '../context.ts';

type SessionOpenLaunchPlan = {
  openPositionals: string[];
  followUpLaunchUrl?: string;
};

export function buildSessionOpenLaunchPlan(params: {
  openPositionals: string[];
  runtime: SessionRuntimeHints | undefined;
  flags: DaemonRequest['flags'];
  foldRuntimeLaunchUrl: boolean;
}): SessionOpenLaunchPlan {
  const { openPositionals, runtime, flags, foldRuntimeLaunchUrl } = params;
  const launchUrl = runtime?.launchUrl;
  if (!launchUrl || openPositionals.length !== 1) {
    return { openPositionals };
  }
  const openTarget = openPositionals[0]?.trim();
  if (!openTarget || isDeepLinkTarget(openTarget)) {
    return { openPositionals };
  }

  const requiresDirectAppLaunch =
    flags?.clearAppState === true ||
    Boolean(flags?.launchConsole?.trim()) ||
    Boolean(flags?.launchArgs?.length);
  if (foldRuntimeLaunchUrl && !requiresDirectAppLaunch) {
    return { openPositionals: [openTarget, launchUrl] };
  }
  return {
    openPositionals,
    followUpLaunchUrl: launchUrl,
  };
}

export async function dispatchSessionOpenFollowUpLaunchUrl(params: {
  launchUrl: string;
  device: DeviceInfo;
  req: DaemonRequest;
  logPath: string;
  appBundleId?: string;
  traceLogPath?: string;
}): Promise<void> {
  const { launchUrl, device, req, logPath, appBundleId, traceLogPath } = params;
  const followUpFlags = req.flags
    ? {
        ...req.flags,
        clearAppState: undefined,
        launchConsole: undefined,
        launchArgs: undefined,
      }
    : undefined;
  const context = contextFromFlags(logPath, followUpFlags, appBundleId, traceLogPath);
  await dispatchCommand(device, 'open', [launchUrl], req.flags?.out, context);
}
