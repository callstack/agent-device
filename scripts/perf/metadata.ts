import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';
import { readGitRevision, readTarget, readToolchain } from '../lib/bench-host.ts';
import { REPO_ROOT, type PerfConfig } from './config.ts';
import type { RunMetadata } from './types.ts';

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function adb(serial: string, args: string[]): string | undefined {
  try {
    const result = runCmdSync('adb', ['-s', serial, ...args], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function emulator(serial: string): RunMetadata['device'] {
  const name = adb(serial, ['emu', 'avd', 'name'])?.split('\n')[0]?.trim();
  const release = adb(serial, ['shell', 'getprop', 'ro.build.version.release']);
  const sdk = adb(serial, ['shell', 'getprop', 'ro.build.version.sdk']);
  return {
    name: name || serial,
    serial,
    runtime: release ? `Android ${release}${sdk ? ` (API ${sdk})` : ''}` : undefined,
  };
}

/** Records what the numbers depend on: source, toolchain, host, and device. */
export function collectMetadata(cfg: PerfConfig): RunMetadata {
  const revision = readGitRevision(REPO_ROOT);
  const toolchain = readToolchain();
  const target =
    cfg.platform === 'ios' ? readTarget(cfg.udid!, cfg.appId, cfg.appPath) : undefined;
  const cpus = os.cpus();
  return {
    commit: revision.commit,
    ref: revision.branch,
    dirty: revision.dirty,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    agentDeviceVersion: readVersion(),
    host: {
      os: toolchain.os,
      arch: toolchain.arch,
      cpu: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    },
    xcode: target ? toolchain.xcode.replaceAll('\n', ' ') : undefined,
    node: toolchain.node,
    device: target
      ? { name: target.name, udid: target.udid, runtime: target.runtime.split('.').pop() }
      : emulator(cfg.serial!),
    fixture: { appId: cfg.appId, appPath: cfg.appPath },
  };
}
