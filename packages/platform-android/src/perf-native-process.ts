import { AppError } from '@agent-device/kernel/errors';
import { shellFragment, shellQuote } from '@agent-device/kernel/device-shell';
import { runAdbShell, type AndroidAdbExecutor } from './adb-executor.ts';
import { buildAndroidNativeToolUnavailableHint } from './perf-native-errors.ts';
import { ANDROID_PERF_TIMEOUT_MS, type AndroidNativePerfKind } from './perf-native-types.ts';

export async function resolveAndroidAppPid(
  adb: AndroidAdbExecutor,
  packageName: string,
): Promise<string> {
  try {
    const result = await runAdbShell(adb, ['pidof', packageName], {
      allowFailure: true,
      timeoutMs: ANDROID_PERF_TIMEOUT_MS,
    });
    const pid = findPidToken(result.stdout);
    if (result.exitCode === 0 && pid) return pid;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new AppError('COMMAND_FAILED', `No active Android app process found for ${packageName}`, {
    package: packageName,
    hint: 'Run open <app> for this session again, wait for the app UI to appear, then retry perf.',
  });
}

export async function assertAndroidNativeToolAvailable(
  adb: AndroidAdbExecutor,
  tool: AndroidNativePerfKind,
  packageName: string,
): Promise<void> {
  const result = await runAdbShell(
    adb,
    [shellFragment(`command -v ${shellQuote(tool)} || which ${shellQuote(tool)}`)],
    {
      allowFailure: true,
      timeoutMs: ANDROID_PERF_TIMEOUT_MS,
    },
  );
  if (result.exitCode === 0 && result.stdout.trim()) return;
  throw new AppError('UNSUPPORTED_OPERATION', `Android device does not expose ${tool}`, {
    package: packageName,
    tool,
    hint: buildAndroidNativeToolUnavailableHint(tool),
  });
}

export function findPidToken(stdout: string): string | undefined {
  return stdout
    .trim()
    .split(/\s+/)
    .find((token) => /^\d+$/.test(token));
}
