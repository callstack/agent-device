import { AppError } from '@agent-device/kernel/errors';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function readHarmonyAppState(
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<AppStateRuntimeResult> {
  signal.throwIfAborted();
  const { runHarmonyShell } = await import('./hdc.ts');
  const result = await runHarmonyShell(device, ['aa', 'dump', '-l'], {
    timeoutMs: 15_000,
    signal,
  });
  signal.throwIfAborted();
  const foreground = parseHarmonyForegroundRead(result.stdout);
  if (foreground.kind !== 'foreground') {
    throw new AppError('COMMAND_FAILED', 'Could not determine the foreground HarmonyOS app', {
      hint: 'Open an app on the target, then retry appstate.',
    });
  }
  return { package: foreground.package, activity: foreground.activity };
}

/**
 * What one `aa dump -l` output yielded. `no-foreground-mission` is a read that answered: the
 * output parsed as a mission list and no mission holds the foreground, which a system surface
 * (the lock screen is the typical one) produces. `unparseable` output names no mission list at
 * all, or a foreground mission whose own name did not parse.
 */
export type HarmonyForegroundParse =
  | { kind: 'foreground'; package: string; activity: string }
  | { kind: 'no-foreground-mission' }
  | { kind: 'unparseable' };

export function parseHarmonyForegroundRead(rawOutput: string): HarmonyForegroundParse {
  const missions = rawOutput.split(/(?=^\s*Mission ID #)/m);
  let sawMission = false;
  for (const mission of missions) {
    if (!/\bMission ID #/.test(mission)) continue;
    sawMission = true;
    if (!/\bstate #FOREGROUND\b/.test(mission)) continue;
    const match = mission.match(/mission name #\[#([^:]+):[^:]*:([^\]]+)]/);
    if (!match) return { kind: 'unparseable' };
    const [, packageName, activity] = match;
    if (!packageName || !activity) return { kind: 'unparseable' };
    return { kind: 'foreground', package: packageName, activity };
  }
  return sawMission ? { kind: 'no-foreground-mission' } : { kind: 'unparseable' };
}
