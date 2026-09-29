import type { SessionAction } from '@agent-device/contracts/session';
import { resolveDeclaredScriptPlatform } from '@agent-device/ad-script';
import type { ResolveTargetDeviceOptions } from '@agent-device/device-selection/dispatch-resolve';
import { appleSimulatorAppTargetForOpenTarget } from '@agent-device/device-selection/open-target';
import { isDeepLinkTarget, type CommandFlags } from '@agent-device/contracts/command';

/**
 * What a replay script says about the device it needs: the platform its recorded `open`/`runtime`
 * actions declare, and the static app target an iOS simulator resolution may key on. Request
 * binding reads the same vocabulary to lock a device before the handler runs.
 *
 * #1555 structural-quality review ("declaredScriptPlatform... move to
 * packages/ad-script"): the platform half of this selection is
 * `resolveDeclaredScriptPlatform` (`@agent-device/ad-script`) — a single
 * shared scan, no longer a second copy kept in sync by hand with
 * `packages/ad-replay/src/internal/inspect.ts`'s own plan-digest precedence.
 * The app-target half stays its own pass here (never fused back into one
 * loop with the platform scan): `resolveDeclaredScriptPlatform` stops at the
 * first `open`, exactly where this function's own app-target search needs
 * to look too, so a second, separate pass over the (typically tiny) actions
 * array costs nothing observable and keeps the shared function free of a
 * daemon-only concern.
 */
export function readScriptReplaySelection(actions: SessionAction[]): {
  appTarget: string | undefined;
  platform: CommandFlags['platform'] | undefined;
} {
  // `resolveDeclaredScriptPlatform` returns a plain `string` — narrowed back
  // to `CommandFlags['platform']` here because both callers only ever feed
  // it a value already typed that way at the source (`runtime`/`open`
  // actions' own recorded flags), so this is a representation return trip,
  // never an unvalidated external string.
  const platform = resolveDeclaredScriptPlatform(actions) as CommandFlags['platform'] | undefined;
  for (const action of actions) {
    if (action.command !== 'open') continue;
    const target = action.positionals?.[0];
    if (isStaticAppTarget(target)) return { appTarget: target, platform };
    return { appTarget: undefined, platform };
  }
  return { appTarget: undefined, platform };
}

export function buildMaestroReplayTargetDeviceResolutionOptions(
  appTarget: string | undefined,
  platform: CommandFlags['platform'] | undefined,
): ResolveTargetDeviceOptions {
  if (platform !== 'ios') return {};
  return appTargetResolutionOptions(appTarget) ?? {};
}

/** Applies a platform configured before the first open to replay dispatch. */
export function buildReplayScriptPlatformFlags(
  flags: CommandFlags | undefined,
  actions: SessionAction[],
): CommandFlags {
  const selection = readScriptReplaySelection(actions);
  if (flags?.platform !== undefined || !selection.platform) {
    return flags ?? {};
  }
  return { ...flags, platform: selection.platform };
}

function isStaticAppTarget(value: string | undefined): value is string {
  return Boolean(value && value.trim() && !value.includes('$') && !isDeepLinkTarget(value));
}

export function appTargetResolutionOptions(
  openTarget: string | undefined,
): ResolveTargetDeviceOptions | undefined {
  const appTarget = appleSimulatorAppTargetForOpenTarget(openTarget);
  return appTarget ? { appleSimulatorAppTarget: appTarget } : undefined;
}
