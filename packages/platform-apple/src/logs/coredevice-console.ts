import type { AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';

export const IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED = {
  message: 'iOS physical-device app console capture is not supported by the installed devicectl.',
  hint: 'This devicectl does not expose process launch --console. Markers can still be written to app.log, but app output is not being captured. Use an iOS simulator for agent-device app logs or inspect physical-device logs in Console.app/Xcode until this Xcode toolchain exposes scriptable console capture.',
} as const;

export const IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED = {
  message: 'Could not verify iOS physical-device app console capture support.',
  hint: 'Retry logs clear --restart. If the probe keeps failing, run logs doctor and inspect the request diagnostics for the devicectl help command.',
} as const;

export type CoreDeviceConsoleCaptureSupport =
  | Readonly<{ supported: true; stderr?: string }>
  | Readonly<{ supported: false; reason: 'unsupported' | 'probe-failed'; stderr?: string }>;

export async function checkCoreDeviceConsoleCaptureSupport(
  host: AppLogRuntimeHost,
  signal?: AbortSignal,
): Promise<CoreDeviceConsoleCaptureSupport> {
  try {
    const result = await host.appleTools.run(
      {
        tool: 'devicectl',
        args: ['device', 'process', 'launch', '--help'],
        allowFailure: true,
        timeoutMs: 5_000,
      },
      signal,
    );
    const stderr = result.stderr.trim() || undefined;
    if (result.exitCode !== 0) return { supported: false, reason: 'probe-failed', stderr };
    const help = `${result.stdout}\n${result.stderr}`;
    const supported =
      /\bUSAGE:\s+devicectl device process launch\b/i.test(help) &&
      /--console\b/.test(help) &&
      /--terminate-existing\b/.test(help);
    return supported
      ? { supported: true, ...(stderr ? { stderr } : {}) }
      : { supported: false, reason: 'unsupported', ...(stderr ? { stderr } : {}) };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return {
      supported: false,
      reason: 'probe-failed',
      ...(error instanceof Error ? { stderr: error.message } : {}),
    };
  }
}
