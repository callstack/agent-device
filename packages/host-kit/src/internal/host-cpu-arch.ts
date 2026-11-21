import { runCmd, runCmdSync } from './exec.ts';

const SYSCTL_TIMEOUT_MS = 1_000;
const APPLE_SILICON_SYSCTL = ['-n', 'hw.optional.arm64'] as const;

let pendingHostCpuArch: Promise<string> | undefined;
let settledHostCpuArch: string | undefined;

/**
 * The machine's native CPU architecture in Apple naming (`arm64`, `x86_64`), which is what
 * simulators on a Mac run by default. Other CPUs keep Node's `process.arch` name. Resolved once
 * per process.
 */
export function readHostCpuArch(): Promise<string> {
  if (settledHostCpuArch !== undefined) return Promise.resolve(settledHostCpuArch);
  pendingHostCpuArch ??= resolveHostCpuArch(process.platform, process.arch).then(settleHostCpuArch);
  return pendingHostCpuArch;
}

/**
 * {@link readHostCpuArch} for a caller that cannot await. It shares the same per-process value,
 * resolving it with a blocking `sysctl` only when nothing has resolved it yet.
 */
export function readHostCpuArchSync(): string {
  return (
    settledHostCpuArch ??
    settleHostCpuArch(
      hostCpuArchName(process.platform === 'darwin' && isAppleSiliconMacSync(), process.arch),
    )
  );
}

function settleHostCpuArch(arch: string): string {
  settledHostCpuArch ??= arch;
  return settledHostCpuArch;
}

export async function resolveHostCpuArch(
  platform: NodeJS.Platform,
  nodeArch: string,
): Promise<string> {
  return hostCpuArchName(platform === 'darwin' && (await isAppleSiliconMac()), nodeArch);
}

function hostCpuArchName(appleSilicon: boolean, nodeArch: string): string {
  if (appleSilicon) return 'arm64';
  return nodeArch === 'x64' ? 'x86_64' : nodeArch;
}

// macOS: `hw.optional.arm64` is 1 on Apple silicon even inside a Rosetta-translated process,
// where `process.arch` reports x64; Intel Macs do not define the key.
async function isAppleSiliconMac(): Promise<boolean> {
  try {
    const result = await runCmd('/usr/sbin/sysctl', APPLE_SILICON_SYSCTL, {
      allowFailure: true,
      timeoutMs: SYSCTL_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout.trim() === '1';
  } catch {
    return false;
  }
}

function isAppleSiliconMacSync(): boolean {
  try {
    const result = runCmdSync('/usr/sbin/sysctl', APPLE_SILICON_SYSCTL, {
      allowFailure: true,
      timeoutMs: SYSCTL_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout.trim() === '1';
  } catch {
    return false;
  }
}
