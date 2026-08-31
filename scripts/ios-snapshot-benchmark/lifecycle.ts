import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class BenchmarkInfrastructureError extends Error {
  readonly command?: string;

  constructor(message: string, command?: string) {
    super(message);
    this.name = 'BenchmarkInfrastructureError';
    this.command = command;
  }
}

export class BenchmarkContentionError extends Error {
  readonly command?: string;

  constructor(message: string, command?: string) {
    super(message);
    this.name = 'BenchmarkContentionError';
    this.command = command;
  }
}

export function bootSimulator(udid: string): void {
  runXcrun(['simctl', 'boot', udid], false);
  const result = runXcrun(['simctl', 'bootstatus', udid, '-b'], true);
  if (result.status !== 0) {
    throw new BenchmarkInfrastructureError(
      `Simulator ${udid} did not reach Booted: ${result.stderr.trim() || 'simctl bootstatus failed'}`,
      `xcrun simctl bootstatus ${udid} -b`,
    );
  }
}

export function shutdownSimulator(udid: string): void {
  runXcrun(['simctl', 'shutdown', udid], false);
}

export function terminateApp(udid: string, appId: string): void {
  runXcrun(['simctl', 'terminate', udid, appId], false);
}

export function stopDaemon(repoRoot: string, stateDir: string): void {
  const result = spawnSync(
    process.execPath,
    ['bin/agent-device.mjs', 'daemon', 'stop', '--state-dir', stateDir, '--clean', '--json'],
    {
      cwd: repoRoot,
      env: { ...process.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error?.code === 'ETIMEDOUT') {
    throw new BenchmarkInfrastructureError(
      `Daemon stop timed out for ${stateDir}.`,
      'agent-device daemon stop --clean',
    );
  }
}

export function clearDerivedData(derivedPath: string): void {
  if (fs.existsSync(derivedPath)) fs.rmSync(derivedPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(derivedPath), { recursive: true });
}

function runXcrun(args: string[], required: boolean): { status: number; stderr: string } {
  const result = spawnSync('xcrun', args, {
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const status = processStatus(result.status);
  const stderr = processStderr(result.stderr);
  if (required && status !== 0) {
    throw new BenchmarkInfrastructureError(
      `xcrun ${args.join(' ')} failed: ${stderr.trim() || 'no diagnostic'}`,
      `xcrun ${args.join(' ')}`,
    );
  }
  return { status, stderr };
}

function processStatus(status: number | null): number {
  return typeof status === 'number' ? status : -1;
}

function processStderr(stderr: string | Buffer | null): string {
  return typeof stderr === 'string' ? stderr : '';
}
