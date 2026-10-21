import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';
import { REPO_ROOT, type PerfConfig } from './config.ts';
import type { RunMetadata } from './types.ts';

function capture(cmd: string, args: string[]): string | undefined {
  try {
    const result = runCmdSync(cmd, args, { cwd: REPO_ROOT, allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function simulator(udid: string): { name: string; runtime?: string } | undefined {
  const raw = capture('xcrun', ['simctl', 'list', 'devices', '--json']);
  if (!raw) return undefined;
  const devices = (JSON.parse(raw) as { devices: Record<string, { udid: string; name: string }[]> })
    .devices;
  for (const [runtime, list] of Object.entries(devices)) {
    const device = list.find((entry) => entry.udid === udid);
    if (device) return { name: device.name, runtime: runtime.split('.').pop() };
  }
  return undefined;
}

/** Records what the numbers depend on: source, toolchain, host, and device. */
export function collectMetadata(cfg: PerfConfig, deviceName: string): RunMetadata {
  const env = process.env;
  const sim = cfg.platform === 'ios' && cfg.udid ? simulator(cfg.udid) : undefined;
  const cpus = os.cpus();
  return {
    commit: env.GITHUB_SHA ?? capture('git', ['rev-parse', 'HEAD']) ?? 'unknown',
    ref: env.GITHUB_REF_NAME ?? capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    agentDeviceVersion: readVersion(),
    host: {
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpu: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    },
    xcode:
      cfg.platform === 'ios'
        ? capture('xcodebuild', ['-version'])?.replaceAll('\n', ' ')
        : undefined,
    node: process.version,
    device: {
      name: sim?.name ?? deviceName,
      udid: cfg.udid,
      serial: cfg.serial,
      runtime: sim?.runtime,
    },
    fixture: cfg.platform === 'ios' ? { appId: cfg.appId, appPath: cfg.appPath } : undefined,
  };
}
