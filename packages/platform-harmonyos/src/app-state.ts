import { AppError } from '@agent-device/kernel/errors';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HarmonyHdcRunner } from './hdc.ts';

export async function readHarmonyAppState(
  hdc: HarmonyHdcRunner,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<AppStateRuntimeResult> {
  signal.throwIfAborted();
  const result = await hdc.runShell(device, ['aa', 'dump', '-l'], {
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
 * output parsed as a mission list with no foreground mission, or answered with no mission block
 * at all, which a system surface that hides the mission list (the lock screen is the typical
 * one) produces. `unparseable` is an empty output, or a foreground mission whose own name did
 * not parse.
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
  // A dump that answers with its section headers but no mission block is the
  // keyguard shape on units whose lock screen hides the mission list: the
  // headers are the dump's own structure, so the read read the device. Error
  // text and empty answers carry no structure and stay unreadable.
  return sawMission || /\bUser ID #/.test(rawOutput)
    ? { kind: 'no-foreground-mission' }
    : { kind: 'unparseable' };
}
