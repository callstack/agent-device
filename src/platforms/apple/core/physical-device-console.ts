import type { ExecResult } from '../../../utils/exec.ts';
import { runXcrun } from './tool-provider.ts';

export type CoreDeviceConsoleCaptureSupport =
  | { supported: true; stderr?: string }
  | { supported: false; reason: 'unsupported' | 'probe-failed'; stderr?: string };

let cachedConsoleCaptureSupport: CoreDeviceConsoleCaptureSupport | undefined;

export function buildCoreDeviceConsoleLaunchArgs(deviceId: string, appBundleId: string): string[] {
  return [
    'devicectl',
    'device',
    'process',
    'launch',
    '--device',
    deviceId,
    '--console',
    '--terminate-existing',
    appBundleId,
  ];
}

export async function checkCoreDeviceAvailable(): Promise<boolean> {
  const result = await runXcrun(['devicectl', '--version'], { allowFailure: true });
  return result.exitCode === 0;
}

export async function checkCoreDeviceConsoleCaptureSupport(): Promise<CoreDeviceConsoleCaptureSupport> {
  if (cachedConsoleCaptureSupport) return cachedConsoleCaptureSupport;
  try {
    const result = await runXcrun(['devicectl', 'device', 'process', 'launch', '--help'], {
      allowFailure: true,
      timeoutMs: 5_000,
    });
    const support = readCoreDeviceConsoleCaptureSupport(result);
    if (support.supported) cachedConsoleCaptureSupport = support;
    return support;
  } catch (error) {
    return {
      supported: false,
      reason: 'probe-failed',
      stderr: error instanceof Error ? error.message : undefined,
    };
  }
}

function readCoreDeviceConsoleCaptureSupport(result: ExecResult): CoreDeviceConsoleCaptureSupport {
  const stderr = result.stderr.trim() || undefined;
  if (result.exitCode !== 0) {
    return { supported: false, reason: 'probe-failed', stderr };
  }
  const help = `${result.stdout}\n${result.stderr}`;
  const supported =
    /\bUSAGE:\s+devicectl device process launch\b/i.test(help) &&
    /--console\b/.test(help) &&
    /--terminate-existing\b/.test(help);
  return supported
    ? { supported: true, stderr }
    : { supported: false, reason: 'unsupported', stderr };
}
