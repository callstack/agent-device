import { AppError } from '@agent-device/kernel/errors';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function readHarmonyAppState(
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<AppStateRuntimeResult> {
  signal.throwIfAborted();
  const { runHarmonyHdc } = await import('./hdc.ts');
  const result = await runHarmonyHdc(device, ['shell', 'aa', 'dump', '-l'], {
    timeoutMs: 15_000,
    signal,
  });
  signal.throwIfAborted();
  const foreground = parseHarmonyForegroundApp(result.stdout);
  if (!foreground) {
    throw new AppError('COMMAND_FAILED', 'Could not determine the foreground HarmonyOS app', {
      hint: 'Open an app on the target, then retry appstate.',
    });
  }
  return foreground;
}

export function parseHarmonyForegroundApp(rawOutput: string): AppStateRuntimeResult | undefined {
  const missions = rawOutput.split(/(?=^\s*Mission ID #)/m);
  for (const mission of missions) {
    if (!/\bstate #FOREGROUND\b/.test(mission)) continue;
    const match = mission.match(/mission name #\[#([^:]+):[^:]*:([^\]]+)]/);
    if (!match) continue;
    const [, packageName, activity] = match;
    if (!packageName || !activity) continue;
    return { package: packageName, activity };
  }
  return undefined;
}
