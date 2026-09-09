import { createHash } from 'node:crypto';
import path from 'node:path';
import { isCommandTimeoutError, type ExecResult } from '@agent-device/host-kit/command';
import { snapshotSourceError } from './errors.ts';
import { remainingSnapshotSourceMs, type SnapshotSourceDeadline } from './deadline.ts';
import type { SnapshotSourceHost } from './types.ts';

/**
 * Per-call timeout for a toolchain identity probe (`xcodebuild -version`,
 * `xcrun --show-sdk-version`, `sw_vers`, `uname`, …). On a fresh macOS host,
 * Apple's syspolicyd signature scan blocks the very first `xcodebuild`/
 * `xcrun`/large-binary exec after boot for roughly 18 to 19 seconds at 0%
 * CPU; the second exec of the same tool is instant. A budget sized for a
 * warm toolchain (the old 10 s / 5 s split) trips on that cold-start stall
 * and reports a bogus toolchain-probe timeout unrelated to the change under
 * test (#2422).
 *
 * `runner/runner-cache-metadata.ts` needs this same budget but cannot import
 * it from here: this module is outside every platform-apple façade's eager
 * closure today, and importing it from `runner-cache-metadata.ts` would pull
 * `snapshot-source/*` into all of them (`scripts/__tests__/eager-closure-
 * budgets.ts`). It instead declares its own copy of this constant, checked
 * against this one for equality by a unit test
 * (`runner/__tests__/runner-cache-metadata.test.ts`) so the two cannot drift
 * apart.
 */
export const COLD_TOOLCHAIN_PROBE_TIMEOUT_MS = 30_000;

export type SnapshotSourceToolchainIdentity = Readonly<{
  xcode: string;
  macosProductVersion: string;
  macosBuild: string;
  architecture: 'arm64' | 'x86_64';
  simulatorSdk: string;
  simulatorRuntime: string;
}>;

export const SNAPSHOT_BRIDGE_SOURCE_FILENAMES = [
  'SnapshotBridge.m',
  'SnapshotBridgeRuntime.m',
  'SnapshotBridgeRuntime.h',
  'SnapshotBridgeCapture.h',
  'SnapshotBridgeCapture.m',
] as const;
export const SNAPSHOT_BRIDGE_COMPILE_FILENAMES = [
  'SnapshotBridge.m',
  'SnapshotBridgeRuntime.m',
  'SnapshotBridgeCapture.m',
] as const;

export async function fingerprintSnapshotBridgeSource(
  host: SnapshotSourceHost,
  root: string,
  deadline: SnapshotSourceDeadline,
): Promise<string> {
  const hash = createHash('sha256');
  for (const sourceFile of SNAPSHOT_BRIDGE_SOURCE_FILENAMES) {
    const filePath = path.join(root, sourceFile);
    remainingSnapshotSourceMs(deadline, 'native-source-fingerprint-deadline');
    if (!host.exists(filePath)) {
      throw snapshotSourceError('unsupported', 'native-source-missing', { filePath });
    }
    hash.update(sourceFile);
    hash.update('\0');
    hash.update(await host.readBinary(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function readSnapshotSourceToolchain(
  host: SnapshotSourceHost,
  simulatorRuntime: string,
  deadline: SnapshotSourceDeadline,
): Promise<SnapshotSourceToolchainIdentity> {
  const xcode = await toolOutput(host, 'xcodebuild', ['-version'], deadline);
  const macosProductVersion = await toolOutput(host, 'sw_vers', ['-productVersion'], deadline);
  const macosBuild = await toolOutput(host, 'sw_vers', ['-buildVersion'], deadline);
  const architecture = await toolOutput(host, 'uname', ['-m'], deadline);
  const simulatorSdk = await toolOutput(
    host,
    'xcrun',
    ['--sdk', 'iphonesimulator', '--show-sdk-version'],
    deadline,
  );
  const runtime = simulatorRuntime.trim();
  if (!runtime) throw snapshotSourceError('unsupported', 'simulator-runtime-missing');
  if (architecture !== 'arm64' && architecture !== 'x86_64') {
    throw snapshotSourceError('unsupported', 'simulator-architecture-unsupported', {
      architecture,
    });
  }
  return {
    xcode,
    macosProductVersion,
    macosBuild,
    architecture,
    simulatorSdk,
    simulatorRuntime: runtime,
  };
}

async function toolOutput(
  host: SnapshotSourceHost,
  command: string,
  args: string[],
  deadline: SnapshotSourceDeadline,
): Promise<string> {
  const result = await runToolchainProbe(host, command, args, deadline);
  if (result.exitCode !== 0) {
    throw snapshotSourceError('unsupported', 'toolchain-probe-failed', {
      command,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 1024),
    });
  }
  const output = (result.stdout || result.stderr).trim();
  if (!output) throw snapshotSourceError('unsupported', 'toolchain-probe-empty', { command });
  return output;
}

/**
 * Runs one toolchain probe, retrying exactly once if the attempt timed out
 * and the deadline still has room. The retry absorbs the cold-start
 * signature-verification stall named on COLD_TOOLCHAIN_PROBE_TIMEOUT_MS: the
 * first exec of a tool on a fresh host can block for that long, but the
 * immediate next exec of the same tool is instant. Only the exec layer's own
 * structured timeout counts -- a tool that failed by itself and merely said
 * "timed out" in its output is not this stall and is not retried.
 */
async function runToolchainProbe(
  host: SnapshotSourceHost,
  command: string,
  args: string[],
  deadline: SnapshotSourceDeadline,
): Promise<ExecResult> {
  try {
    return await execToolchainProbe(host, command, args, deadline);
  } catch (error) {
    if (!isCommandTimeoutError(error) || !toolchainProbeDeadlineHasRoom(deadline)) throw error;
    return await execToolchainProbe(host, command, args, deadline);
  }
}

function execToolchainProbe(
  host: SnapshotSourceHost,
  command: string,
  args: string[],
  deadline: SnapshotSourceDeadline,
): Promise<ExecResult> {
  return host.run(command, args, {
    allowFailure: true,
    signal: deadline.signal,
    timeoutMs: Math.min(
      COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
      remainingSnapshotSourceMs(deadline, 'toolchain-probe-deadline'),
    ),
  });
}

function toolchainProbeDeadlineHasRoom(deadline: SnapshotSourceDeadline): boolean {
  return !deadline.signal?.aborted && deadline.clock.remainingMs() > 0;
}
