import { runCmd } from './exec.ts';

const SYSCTL_TIMEOUT_MS = 1_000;

let hostCpuArch: Promise<string> | undefined;

/**
 * The machine's native CPU architecture in Apple naming (`arm64`, `x86_64`), which is what
 * simulators on a Mac run by default. Other CPUs keep Node's `process.arch` name. Resolved once
 * per process.
 */
export function readHostCpuArch(): Promise<string> {
  hostCpuArch ??= resolveHostCpuArch(process.platform, process.arch);
  return hostCpuArch;
}

export async function resolveHostCpuArch(
  platform: NodeJS.Platform,
  nodeArch: string,
): Promise<string> {
  if (platform === 'darwin' && (await isAppleSiliconMac())) return 'arm64';
  return nodeArch === 'x64' ? 'x86_64' : nodeArch;
}

// macOS: `hw.optional.arm64` is 1 on Apple silicon even inside a Rosetta-translated process,
// where `process.arch` reports x64; Intel Macs do not define the key.
async function isAppleSiliconMac(): Promise<boolean> {
  try {
    const result = await runCmd('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], {
      allowFailure: true,
      timeoutMs: SYSCTL_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout.trim() === '1';
  } catch {
    return false;
  }
}
