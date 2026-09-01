import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BenchmarkStopReason } from './types.ts';

const BENCHMARK_OWNER_MARKER = '.agent-device-ios-snapshot-benchmark-owner';
const BENCHMARK_OWNER_MARKER_CONTENT = 'agent-device-ios-snapshot-benchmark.v1\n';

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

export class BenchmarkCellAdmissionError extends BenchmarkInfrastructureError {
  readonly reason: BenchmarkStopReason;

  constructor(reason: BenchmarkStopReason, message: string, command?: string) {
    super(message, command);
    this.name = 'BenchmarkCellAdmissionError';
    this.reason = reason;
  }
}

export function bootSimulator(udid: string): void {
  if (readSimulatorState(udid) !== 'Booted') {
    const boot = runXcrun(['simctl', 'boot', udid], false);
    if (boot.status !== 0) {
      throw new BenchmarkInfrastructureError(
        `xcrun simctl boot ${udid} failed: ${boot.stderr.trim() || 'no diagnostic'}`,
        `xcrun simctl boot ${udid}`,
      );
    }
  }
  const result = runXcrun(['simctl', 'bootstatus', udid, '-b'], true);
  if (result.status !== 0) {
    throw new BenchmarkInfrastructureError(
      `Simulator ${udid} did not reach Booted: ${result.stderr.trim() || 'simctl bootstatus failed'}`,
      `xcrun simctl bootstatus ${udid} -b`,
    );
  }
  if (readSimulatorState(udid) !== 'Booted') {
    throw new BenchmarkInfrastructureError(
      `Simulator ${udid} did not reach Booted after bootstatus.`,
      `xcrun simctl bootstatus ${udid} -b`,
    );
  }
}

export function shutdownSimulator(udid: string): void {
  if (readSimulatorState(udid) === 'Shutdown') return;
  const result = runXcrun(['simctl', 'shutdown', udid], false);
  if (result.status !== 0) {
    throw new BenchmarkInfrastructureError(
      `xcrun simctl shutdown ${udid} failed: ${result.stderr.trim() || 'no diagnostic'}`,
      `xcrun simctl shutdown ${udid}`,
    );
  }
  if (readSimulatorState(udid) !== 'Shutdown') {
    throw new BenchmarkInfrastructureError(
      `Simulator ${udid} did not reach Shutdown after shutdown.`,
      `xcrun simctl shutdown ${udid}`,
    );
  }
}

export function terminateApp(udid: string, appId: string): void {
  if (readSimulatorState(udid) !== 'Booted') {
    throw new BenchmarkInfrastructureError(
      `Simulator ${udid} must be Booted before terminating ${appId}.`,
      `xcrun simctl terminate ${udid} ${appId}`,
    );
  }
  if (readRunningAppPids(udid, appId).length === 0) return;
  const result = runXcrun(['simctl', 'terminate', udid, appId], false);
  if (result.status !== 0) {
    throw new BenchmarkInfrastructureError(
      `xcrun simctl terminate ${udid} ${appId} failed: ${result.stderr.trim() || 'no diagnostic'}`,
      `xcrun simctl terminate ${udid} ${appId}`,
    );
  }
  if (readRunningAppPids(udid, appId).length > 0) {
    throw new BenchmarkInfrastructureError(
      `App ${appId} remained running on simulator ${udid} after terminate.`,
      `xcrun simctl terminate ${udid} ${appId}`,
    );
  }
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
  if (result.error || result.status !== 0) {
    const diagnostic = processStderr(result.stderr);
    throw new BenchmarkInfrastructureError(
      `Daemon stop failed for ${stateDir}: ${diagnostic.trim() || result.error?.message || `exit ${String(result.status)}`}`,
      'agent-device daemon stop --clean',
    );
  }
  if (
    fs.existsSync(path.join(stateDir, 'daemon.json')) ||
    fs.existsSync(path.join(stateDir, 'daemon.lock'))
  ) {
    throw new BenchmarkInfrastructureError(
      `Daemon metadata remained after stopping ${stateDir}.`,
      'agent-device daemon stop --clean',
    );
  }
}

export function clearDerivedData(derivedPath: string, ownerRoot: string): void {
  assertOwnedDerivedPath(derivedPath, ownerRoot);
  if (fs.existsSync(derivedPath)) fs.rmSync(derivedPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(derivedPath), { recursive: true });
}

export function ensureBenchmarkOwner(ownerRoot: string): void {
  fs.mkdirSync(ownerRoot, { recursive: true });
  const markerPath = path.join(ownerRoot, BENCHMARK_OWNER_MARKER);
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(markerPath, BENCHMARK_OWNER_MARKER_CONTENT, { flag: 'wx' });
    return;
  }
  if (fs.lstatSync(markerPath).isSymbolicLink()) {
    throw new BenchmarkCellAdmissionError(
      'derived-path',
      `Benchmark owner marker must not be a symbolic link: ${markerPath}`,
    );
  }
  if (fs.readFileSync(markerPath, 'utf8') !== BENCHMARK_OWNER_MARKER_CONTENT) {
    throw new BenchmarkCellAdmissionError(
      'derived-path',
      `Benchmark owner marker is invalid: ${markerPath}`,
    );
  }
}

export function assertOwnedDerivedPath(derivedPath: string, ownerRoot: string): void {
  ensureBenchmarkOwner(ownerRoot);
  const resolvedOwnerRoot = path.resolve(ownerRoot);
  const resolvedDerivedPath = path.resolve(derivedPath);
  if (!isDescendant(resolvedDerivedPath, resolvedOwnerRoot)) {
    throw new BenchmarkCellAdmissionError(
      'derived-path',
      `Derived-data path must be a descendant of the benchmark state directory.`,
    );
  }
  if (fs.existsSync(resolvedDerivedPath) && fs.lstatSync(resolvedDerivedPath).isSymbolicLink()) {
    throw new BenchmarkCellAdmissionError(
      'derived-path',
      `Derived-data path must not be a symbolic link: ${resolvedDerivedPath}`,
    );
  }
  const realOwnerRoot = fs.realpathSync.native(resolvedOwnerRoot);
  const realExistingParent = fs.realpathSync.native(findExistingPath(resolvedDerivedPath));
  if (!isDescendantOrSame(realExistingParent, realOwnerRoot)) {
    throw new BenchmarkCellAdmissionError(
      'derived-path',
      `Derived-data path resolves outside the benchmark state directory.`,
    );
  }
}

export function readSimulatorState(udid: string): string {
  const result = runXcrun(['simctl', 'list', 'devices', 'available', '--json'], true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new BenchmarkInfrastructureError(
      `simctl returned invalid device metadata for ${udid}.`,
      'xcrun simctl list devices available --json',
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed.devices)) {
    throw new BenchmarkInfrastructureError(
      `simctl returned no device metadata for ${udid}.`,
      'xcrun simctl list devices available --json',
    );
  }
  for (const devices of Object.values(parsed.devices)) {
    if (!Array.isArray(devices)) continue;
    const match = devices.find((device) => isRecord(device) && device.udid === udid);
    if (isRecord(match) && typeof match.state === 'string') return match.state;
  }
  throw new BenchmarkInfrastructureError(
    `Simulator ${udid} was not found in simctl device metadata.`,
    'xcrun simctl list devices available --json',
  );
}

export function readRunningAppPids(udid: string, appId: string): number[] {
  const result = runXcrun(['simctl', 'spawn', udid, 'launchctl', 'list'], true);
  return parseRunningAppPids(result.stdout, appId);
}

export function parseRunningAppPids(output: string, appId: string): number[] {
  const prefix = `UIKitApplication:${appId}[`;
  const pids: number[] = [];
  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/u);
    const pid = Number(columns[0]);
    const label = columns.slice(2).join(' ');
    if (Number.isSafeInteger(pid) && pid > 0 && label.startsWith(prefix)) pids.push(pid);
  }
  return [...new Set(pids)];
}

function runXcrun(
  args: string[],
  required: boolean,
): { status: number; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync('xcrun', args, {
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const status = processStatus(result.status);
  const stdout = processOutput(result.stdout);
  const stderr = processStderr(result.stderr);
  if (required && status !== 0) {
    throw new BenchmarkInfrastructureError(
      `xcrun ${args.join(' ')} failed: ${stderr.trim() || result.error?.message || 'no diagnostic'}`,
      `xcrun ${args.join(' ')}`,
    );
  }
  return { status, stdout, stderr, ...(result.error ? { error: result.error } : {}) };
}

function processStatus(status: number | null): number {
  return typeof status === 'number' ? status : -1;
}

function processStderr(stderr: string | Buffer | null): string {
  return typeof stderr === 'string' ? stderr : '';
}

function processOutput(stdout: string | Buffer | null): string {
  return typeof stdout === 'string' ? stdout : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isDescendantOrSame(candidate: string, root: string): boolean {
  return candidate === root || isDescendant(candidate, root);
}

function findExistingPath(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new BenchmarkCellAdmissionError(
        'derived-path',
        `Could not resolve derived-data parent: ${target}`,
      );
    }
    current = parent;
  }
  return current;
}
