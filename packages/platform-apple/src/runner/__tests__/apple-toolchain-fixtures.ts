import { beforeEach, vi } from 'vitest';
import { appleRunnerTestHost } from '../test-host.ts';
import type { ExecResult } from '../host.ts';

const STUBBED_APPLE_TOOLCHAIN = {
  xcodeVersion: '26.2',
  xcodeBuildVersion: '17C52',
  sdkVersion: '26.2',
  sdkBuildVersion: '23C53',
} as const;

export function appleToolchainProbeResult(command: string, args: readonly string[]): ExecResult {
  if (command === 'xcodebuild' && args[0] === '-version') {
    return {
      exitCode: 0,
      stdout: `Xcode ${STUBBED_APPLE_TOOLCHAIN.xcodeVersion}\nBuild version ${STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion}\n`,
      stderr: '',
    };
  }
  if (command === 'xcrun' && args.includes('--show-sdk-build-version')) {
    return { exitCode: 0, stdout: `${STUBBED_APPLE_TOOLCHAIN.sdkBuildVersion}\n`, stderr: '' };
  }
  if (command === 'xcrun' && args.includes('--show-sdk-version')) {
    return { exitCode: 0, stdout: `${STUBBED_APPLE_TOOLCHAIN.sdkVersion}\n`, stderr: '' };
  }
  throw new Error(`Unexpected Apple toolchain probe: ${command} ${args.join(' ')}`);
}

/**
 * Answers the runner cache's toolchain probes from a fixed toolchain, so cases
 * that key the cache neither read the host's Xcode nor depend on one existing.
 * Returns the mock so a case can make a probe fail.
 */
export function stubAppleToolchainProbes(): ReturnType<typeof vi.fn> {
  const runCmdSync = vi.fn(appleToolchainProbeResult);
  beforeEach(() => {
    runCmdSync.mockImplementation(appleToolchainProbeResult);
    appleRunnerTestHost.update({ runCmdSync });
  });
  return runCmdSync;
}
