import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { GitRevision, Target, Toolchain } from './types.ts';

export function readToolchain(): Toolchain {
  return {
    node: process.version,
    pnpm: commandVersion('pnpm', ['--version']),
    xcode: commandText('xcodebuild', ['-version']),
    simctl: commandText('xcrun', ['simctl', '--version']),
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
  };
}

export function readGitRevision(repoRoot: string): GitRevision {
  return {
    commit: commandText('git', ['rev-parse', 'HEAD'], repoRoot),
    branch: commandText('git', ['branch', '--show-current'], repoRoot) || 'detached',
    dirty: commandText('git', ['status', '--porcelain'], repoRoot).length > 0,
  };
}

export function readTarget(udid: string, appId: string, appPath?: string): Target {
  const inventory = parseSimctlDevices(
    commandText('xcrun', ['simctl', 'list', 'devices', 'available', '--json']),
  );
  const device = inventory.find((candidate) => candidate.udid === udid);
  if (!device) throw new Error(`Simulator ${udid} is not available in simctl inventory.`);
  return {
    platform: 'ios',
    kind: 'simulator',
    udid,
    name: device.name,
    runtime: device.runtime,
    appId,
    ...(appPath ? { appPath } : {}),
  };
}

function commandText(command: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unavailable';
  }
}

function commandVersion(command: string, args: string[]): string {
  return commandText(command, args) || 'unavailable';
}

function parseSimctlDevices(
  output: string,
): Array<{ udid: string; name: string; runtime: string }> {
  if (output === 'unavailable') return [];
  try {
    const parsed = JSON.parse(output) as {
      devices?: Record<string, Array<{ udid?: string; name?: string; state?: string }>>;
    };
    return Object.entries(parsed.devices ?? {}).flatMap(([runtime, devices]) =>
      devices.flatMap((device) =>
        device.udid && device.name ? [{ udid: device.udid, name: device.name, runtime }] : [],
      ),
    );
  } catch {
    return [];
  }
}

export function resolveRepoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..');
}
