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

/** How long the open-time foreground probe may hold one `aa dump -l` read on its own. */
const HARMONY_OPEN_PROBE_READ_TIMEOUT_MS = 15_000;

/**
 * Reads which bundle holds the foreground at open time, or `undefined` when no read answers. The
 * open-time probe is advisory: an unreadable read claims nothing and never fails the open it
 * informs. The read never outlives the request's remaining deadline (`requestDeadlineAtMs`): with
 * less room left than the 15s default, the read gets the remainder, a spent deadline skips the
 * device entirely, and the probe still claims nothing (#4860 follow-up — the same clamp the
 * post-open foreground poll runs under).
 */
export async function probeHarmonyForegroundBundle(
  device: DeviceInfo,
  signal: AbortSignal,
  options: Readonly<{ deadlineAtMs?: number }> = {},
): Promise<string | undefined> {
  const readTimeoutMs =
    options.deadlineAtMs === undefined
      ? HARMONY_OPEN_PROBE_READ_TIMEOUT_MS
      : Math.min(HARMONY_OPEN_PROBE_READ_TIMEOUT_MS, options.deadlineAtMs - Date.now());
  // A spent deadline leaves no room for one read: the probe answers without
  // touching the device instead of arming no timer at all.
  if (readTimeoutMs <= 0) return undefined;
  try {
    const { runHarmonyShell } = await import('./hdc.ts');
    const result = await runHarmonyShell(device, ['aa', 'dump', '-l'], {
      timeoutMs: readTimeoutMs,
      signal,
    });
    const foreground = parseHarmonyForegroundRead(result.stdout);
    return foreground.kind === 'foreground' ? foreground.package : undefined;
  } catch {
    return undefined;
  }
}
