import type {
  AppLogBackgroundProcess,
  AppLogBackgroundProcessRequest,
  AppLogProcessMarker,
  AppLogProcessMarkerReadOutcome,
  AppLogProcessOwnership,
  AppLogProcessCommand,
} from '@agent-device/contracts/app-log-runtime';
import type {
  HostCommandRequest,
  HostCommandResult,
} from '@agent-device/contracts/platform-runtime-host';
import { decodeAppLogProcessMarker } from '@agent-device/capture-kit';
import type { DeviceIdentity } from '@agent-device/kernel/device';
import fs from 'node:fs';
import path from 'node:path';
import { runCmdBackground } from './utils/exec.ts';
import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  waitForProcessExit,
} from './utils/host-process.ts';
import { requireManagedSessionArtifactPath } from './utils/managed-session-artifact-path.ts';
import { openVerifiedFileForRead } from './utils/verified-file.ts';

const APP_LOG_PID_FILENAME = 'app-log.pid';

type ManagedAppLogCommandChild = Readonly<{
  pid?: number;
  exitCode?: number | null;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}>;

export type ManagedAppLogCommand = Readonly<{
  child: ManagedAppLogCommandChild;
  wait: Promise<HostCommandResult>;
}>;

export type ManagedAppLogCommandLauncher = (
  command: AppLogProcessCommand,
  signal?: AbortSignal,
) => ManagedAppLogCommand | Promise<ManagedAppLogCommand>;

export function createManagedAppLogProcesses(
  sessionsDir: string,
  options: Readonly<{ launch?: ManagedAppLogCommandLauncher }> = {},
) {
  const root = path.resolve(sessionsDir);
  const launch = options.launch ?? launchLocalAppLogCommand;
  return Object.freeze({
    start: async (request: AppLogBackgroundProcessRequest, signal?: AbortSignal) =>
      await startAppLogProcess(root, request, launch, signal),
    readMarker: async (markerPath: string) => readMarker(root, markerPath),
    clearMarker: async (markerPath: string) => clearMarker(root, markerPath),
    inspect: async (marker: AppLogProcessMarker) => inspectOwnedProcess(marker),
    terminate: async (marker: AppLogProcessMarker) => await terminateOwnedProcess(marker),
  });
}

export type LegacyAppLogMarkerRecovery = Readonly<{
  recovered: readonly string[];
  retained: readonly Readonly<{
    markerPath: string;
    reason: 'invalid' | 'ownership-lost';
    message?: string;
    device?: DeviceIdentity;
  }>[];
}>;

/** Recovers marker-only sessions after the daemon lock is held. */
export async function recoverLegacyAppLogMarkersAfterDaemonLock(
  sessionsDir: string,
): Promise<LegacyAppLogMarkerRecovery> {
  const recovered: string[] = [];
  const retained: Array<{
    markerPath: string;
    reason: 'invalid' | 'ownership-lost';
    message?: string;
    device?: DeviceIdentity;
  }> = [];
  if (!fs.existsSync(sessionsDir)) return { recovered, retained };
  const root = path.resolve(sessionsDir);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(root, entry.name);
    if (fs.existsSync(path.join(sessionDir, 'app-log.resource.json'))) continue;
    const markerPath = path.join(sessionDir, APP_LOG_PID_FILENAME);
    const read = readMarker(root, markerPath);
    if (read.status === 'missing') continue;
    if (read.status === 'invalid') {
      retained.push({ markerPath, reason: 'invalid', message: read.message });
      continue;
    }
    const outcome = await terminateOwnedProcess(read.marker);
    if (outcome === 'ownership-lost') {
      const device = legacyMarkerDeviceIdentity(read.marker.command);
      retained.push({ markerPath, reason: 'ownership-lost', ...(device ? { device } : {}) });
      continue;
    }
    clearMarker(root, markerPath);
    recovered.push(markerPath);
  }
  return Object.freeze({ recovered: Object.freeze(recovered), retained: Object.freeze(retained) });
}

function legacyMarkerDeviceIdentity(command: string): DeviceIdentity | undefined {
  const android = /(?:^|\s)(?:\S*\/)?adb\s+-s\s+([^\s]+)/.exec(command)?.[1];
  if (android) {
    return Object.freeze({
      id: android,
      family: 'android',
      kind: android.startsWith('emulator-') ? 'emulator' : 'device',
      target: 'mobile',
    });
  }
  const simulator = /(?:^|\s)xcrun\s+(?:--set\s+\S+\s+)?simctl\s+spawn\s+([^\s]+)/.exec(
    command,
  )?.[1];
  if (simulator) {
    return Object.freeze({
      id: simulator,
      family: 'apple',
      appleOs: 'ios',
      kind: 'simulator',
      target: 'mobile',
    });
  }
  const device = /(?:^|\s)xcrun\s+devicectl\b[^\n]*?\s--device\s+([^\s]+)/.exec(command)?.[1];
  if (!device) return undefined;
  return Object.freeze({
    id: device,
    family: 'apple',
    appleOs: 'ios',
    kind: 'device',
    target: 'mobile',
    iosPhysicalDeviceBackend: 'coredevice',
  });
}

async function startAppLogProcess(
  root: string,
  request: AppLogBackgroundProcessRequest,
  launch: ManagedAppLogCommandLauncher,
  signal?: AbortSignal,
): Promise<AppLogBackgroundProcess> {
  assertMarkerAvailable(root, request.markerPath);
  signal?.throwIfAborted();
  const background = await launch(request.command, signal);
  const child = background.child;
  const waitForWrites = forwardProcessOutput(child, request.output);
  const marker = await publishProcessMarkerOrRollback(root, request.markerPath, background);
  const wait = background.wait
    .then(async (result) => {
      await waitForWrites();
      return result;
    })
    .finally(() => {
      if (request.markerPath && marker) clearPublishedMarker(root, request.markerPath, marker);
    });
  const terminate = createManagedProcessTermination(child, wait);
  return { marker, wait, terminate, [Symbol.asyncDispose]: terminate };
}

function launchLocalAppLogCommand(
  command: AppLogProcessCommand,
  signal?: AbortSignal,
): ManagedAppLogCommand {
  const request = localHostCommand(command);
  return runCmdBackground(request.executable, [...request.args], {
    allowFailure: request.allowFailure,
    cwd: request.cwd,
    env: request.env ? { ...process.env, ...request.env } : undefined,
    timeoutMs: request.timeoutMs,
    captureOutput: false,
    signal,
  });
}

function localHostCommand(command: AppLogProcessCommand): HostCommandRequest {
  if (command.kind === 'host') return command.request;
  return {
    executable: 'adb',
    args: ['-s', command.serial, ...command.args],
    ...command.options,
  };
}

function assertMarkerAvailable(root: string, markerPath?: string): void {
  if (!markerPath) return;
  if (readMarker(root, markerPath).status === 'missing') return;
  throw new Error('Existing app-log process marker evidence must be recovered before start');
}

function forwardProcessOutput(
  child: ManagedAppLogCommandChild,
  output: AppLogBackgroundProcessRequest['output'],
): () => Promise<void> {
  let writes = Promise.resolve();
  let firstWriteError: unknown;
  const forward = (chunk: string | Buffer) => {
    writes = writes
      .then(async () => await output.write(chunk))
      .catch((error: unknown) => {
        firstWriteError ??= error;
        if (typeof child.exitCode !== 'number') child.kill('SIGKILL');
      });
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  return async () => {
    await writes;
    if (firstWriteError !== undefined) throw firstWriteError;
  };
}

async function publishProcessMarkerOrRollback(
  root: string,
  markerPath: string | undefined,
  background: ManagedAppLogCommand,
): Promise<AppLogProcessMarker | undefined> {
  const marker = background.child.pid
    ? await resolveProcessMarker(background.child.pid)
    : undefined;
  try {
    if (!marker) {
      throw new Error('Managed app-log process did not expose a complete ownership marker');
    }
    if (markerPath) writeMarker(root, markerPath, marker);
    return marker;
  } catch (error) {
    background.child.kill('SIGKILL');
    await background.wait.catch(() => undefined);
    throw error;
  }
}

function createManagedProcessTermination(
  child: ManagedAppLogCommandChild,
  wait: AppLogBackgroundProcess['wait'],
): () => Promise<void> {
  let termination: Promise<void> | undefined;
  return async () =>
    await (termination ??= (async () => {
      if (typeof child.exitCode === 'number') return;
      child.kill('SIGINT');
      if (!(await settlesWithin(wait, 2_000))) child.kill('SIGKILL');
      await wait.catch(() => undefined);
    })());
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    const settled = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    void promise.then(settled, settled);
  });
}

function clearPublishedMarker(
  root: string,
  markerPath: string,
  published: AppLogProcessMarker,
): void {
  const current = readMarker(root, markerPath);
  if (
    current.status === 'decoded' &&
    current.marker.pid === published.pid &&
    current.marker.startTime === published.startTime &&
    current.marker.command === published.command
  ) {
    clearMarker(root, markerPath);
  }
}

function processMarker(pid: number): AppLogProcessMarker | undefined {
  const startTime = readProcessStartTime(pid);
  const command = readProcessCommand(pid);
  if (!startTime || !command) return undefined;
  return Object.freeze({
    pid,
    startTime,
    command,
  });
}

async function resolveProcessMarker(pid: number): Promise<AppLogProcessMarker | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const marker = processMarker(pid);
    if (marker) return marker;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

function readMarker(root: string, markerPath: string): AppLogProcessMarkerReadOutcome {
  const resolved = requireManagedMarkerPath(root, markerPath);
  let handle: number;
  try {
    const opened = openVerifiedFileForRead(resolved);
    if (opened === undefined) return { status: 'missing' };
    handle = opened;
  } catch (error) {
    return {
      status: 'invalid',
      message: error instanceof Error ? error.message : 'App-log process marker is invalid',
    };
  }
  try {
    const value = JSON.parse(fs.readFileSync(handle, 'utf8')) as unknown;
    return decodeAppLogProcessMarker(value);
  } catch (error) {
    return {
      status: 'invalid',
      message: error instanceof Error ? error.message : 'App-log process marker is invalid',
    };
  } finally {
    fs.closeSync(handle);
  }
}

function writeMarker(root: string, markerPath: string, marker: AppLogProcessMarker): void {
  const resolved = requireManagedMarkerPath(root, markerPath);
  if (readMarker(root, resolved).status !== 'missing') {
    throw new Error(
      'Existing app-log process marker evidence must be recovered before replacement',
    );
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  let handle: number | undefined;
  let linked = false;
  let published = false;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(marker)}\n`);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.linkSync(temporary, resolved);
    linked = true;
    fs.unlinkSync(temporary);
    const directory = fs.openSync(path.dirname(resolved), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    published = true;
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Preserve the publication failure.
      }
    }
    if (!published) {
      for (const unresolvedPath of linked ? [resolved, temporary] : [temporary]) {
        try {
          fs.unlinkSync(unresolvedPath);
        } catch {
          // Keep the original publication failure.
        }
      }
    }
  }
}

function clearMarker(root: string, markerPath: string): void {
  const resolved = requireManagedMarkerPath(root, markerPath);
  try {
    fs.unlinkSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function requireManagedMarkerPath(root: string, markerPath: string): string {
  return requireManagedSessionArtifactPath({
    sessionsDir: root,
    pathname: markerPath,
    basename: APP_LOG_PID_FILENAME,
    label: 'App-log process marker',
  });
}

function inspectOwnedProcess(marker: AppLogProcessMarker): AppLogProcessOwnership {
  if (!isProcessAlive(marker.pid)) return 'missing';
  return markerMatchesLiveProcess(marker) ? 'owned-alive' : 'ownership-lost';
}

async function terminateOwnedProcess(
  marker: AppLogProcessMarker,
): Promise<'terminated' | 'already-missing' | 'ownership-lost'> {
  if (!isProcessAlive(marker.pid)) return 'already-missing';
  if (!markerMatchesLiveProcess(marker)) return 'ownership-lost';
  try {
    process.kill(marker.pid, 'SIGTERM');
  } catch {
    return 'already-missing';
  }
  if (!(await waitForProcessExit(marker.pid, 2_000))) {
    if (!markerMatchesLiveProcess(marker)) return 'ownership-lost';
    try {
      process.kill(marker.pid, 'SIGKILL');
    } catch {
      return 'already-missing';
    }
    await waitForProcessExit(marker.pid, 2_000);
  }
  return isProcessAlive(marker.pid) ? 'ownership-lost' : 'terminated';
}

function markerMatchesLiveProcess(marker: AppLogProcessMarker): boolean {
  if (!marker.startTime || !marker.command) return false;
  return (
    readProcessStartTime(marker.pid) === marker.startTime &&
    readProcessCommand(marker.pid) === marker.command
  );
}
