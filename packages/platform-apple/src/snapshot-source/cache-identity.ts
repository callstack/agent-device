import { createHash } from 'node:crypto';
import path from 'node:path';
import { snapshotSourceError } from './errors.ts';
import { remainingSnapshotSourceMs, type SnapshotSourceDeadline } from './deadline.ts';
import type { SnapshotSourceHost } from './types.ts';

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
] as const;
export const SNAPSHOT_BRIDGE_COMPILE_FILENAMES = [
  'SnapshotBridge.m',
  'SnapshotBridgeRuntime.m',
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
  const result = await host.run(command, args, {
    allowFailure: true,
    signal: deadline.signal,
    timeoutMs: Math.min(10_000, remainingSnapshotSourceMs(deadline, 'toolchain-probe-deadline')),
  });
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
