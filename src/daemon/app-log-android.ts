import fs from 'node:fs';
import {
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  type AndroidAdbProcess,
} from '../platforms/android/adb-executor.ts';
import { androidDeviceForSerial } from '../platforms/android/adb.ts';
import {
  captureAndroidLogcatWithAdb,
  streamAndroidLogcatWithAdb,
} from '../platforms/android/logcat.ts';
import { AppError } from '../kernel/errors.ts';
import {
  clearPidFile,
  readStoredAppLogProcessMeta,
  writePidFile,
  type AppLogResult,
  type AppLogState,
} from './app-log-process.ts';
import { attachChildToStream, createLineWriter, waitForChildExit } from './app-log-stream.ts';
import { sleep } from '../utils/timeouts.ts';

export function assertAndroidPackageArgSafe(appBundleId: string): void {
  if (!/^[a-zA-Z0-9._:-]+$/.test(appBundleId)) {
    throw new AppError('INVALID_ARGS', `Invalid Android package name for logs: ${appBundleId}`);
  }
}

export async function resolveAndroidPid(
  deviceId: string,
  appBundleId: string,
): Promise<string | null> {
  const pidResult = await resolveAndroidAdbExecutor(androidDeviceForSerial(deviceId))(
    ['shell', 'pidof', appBundleId],
    { allowFailure: true },
  );
  const pid = pidResult.stdout.trim().split(/\s+/)[0];
  if (!pid || !/^\d+$/.test(pid)) return null;
  return pid;
}

export function readTrackedAndroidLogcatPid(pidPath: string | undefined): string | null {
  const command = readStoredAppLogProcessMeta(pidPath)?.command;
  if (!command) return null;
  const match = /(?:^|\s)--pid\s+(\d+)(?:\s|$)/.exec(command);
  return match?.[1] ?? null;
}

export async function readRecentAndroidLogcatForPackage(
  deviceId: string,
  appBundleId: string,
): Promise<{ pid: string | null; text: string; recoveredPids: string[] } | null> {
  assertAndroidPackageArgSafe(appBundleId);
  const pid = await resolveAndroidPid(deviceId, appBundleId);
  const adb = resolveAndroidAdbExecutor(androidDeviceForSerial(deviceId));
  const text = await captureAndroidLogcatWithAdb(adb, { lines: 4000, timeoutMs: 3_000 }).catch(
    () => '',
  );
  if (text.trim().length === 0) {
    return null;
  }
  const recoveredPids = collectAndroidPackagePids(text, appBundleId, pid);
  if (recoveredPids.length === 0) {
    return null;
  }
  const filteredText = filterAndroidLogcatToPids(text, appBundleId, recoveredPids);
  if (filteredText.trim().length === 0) {
    return null;
  }
  return { pid, text: filteredText, recoveredPids };
}

export async function startAndroidAppLog(
  deviceId: string,
  appBundleId: string,
  stream: fs.WriteStream,
  redactionPatterns: RegExp[],
  pidPath?: string,
): Promise<AppLogResult> {
  let state: AppLogState = 'recovering';
  let stopped = false;
  let activeChild: AndroidAdbProcess | undefined;
  let activeWait: ReturnType<typeof attachChildToStream> | undefined;

  const wait = (async () => {
    try {
      while (!stopped) {
        const pid = await resolveAndroidPid(deviceId, appBundleId);
        if (!pid) {
          state = 'recovering';
          await sleep(1_000);
          continue;
        }
        const provider = resolveAndroidAdbProvider(androidDeviceForSerial(deviceId));
        const child = streamAndroidLogcatWithAdb(provider, { pid });
        activeChild = child;
        const writer = createLineWriter(stream, { redactionPatterns });
        activeWait = attachChildToStream(child, stream, { endStreamOnClose: false, writer });
        if (typeof child.pid === 'number') {
          writePidFile(pidPath, child.pid);
        }
        state = 'active';
        await activeWait;
        clearPidFile(pidPath);
        activeChild = undefined;
        activeWait = undefined;
        if (stopped) return { stdout: '', stderr: '', exitCode: 0 };
        state = 'recovering';
        await sleep(500);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    } finally {
      stream.end();
      clearPidFile(pidPath);
    }
  })();

  return {
    backend: 'android',
    getState: () => state,
    startedAt: Date.now(),
    wait,
    stop: async () => {
      stopped = true;
      if (activeChild && !activeChild.killed) {
        activeChild.kill('SIGINT');
      }
      if (activeWait) await waitForChildExit(activeWait);
      if (activeChild && !activeChild.killed) {
        activeChild.kill('SIGKILL');
      }
      await waitForChildExit(wait);
      clearPidFile(pidPath);
    },
  };
}

function collectAndroidPackagePids(
  content: string,
  appBundleId: string,
  currentPid: string | null,
): string[] {
  const pids = new Set<string>();
  if (currentPid) {
    pids.add(currentPid);
  }
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.includes(appBundleId)) continue;
    for (const candidate of extractAndroidPidsFromPackageLine(line, appBundleId)) {
      pids.add(candidate);
    }
  }
  return [...pids];
}

function extractAndroidPidsFromPackageLine(line: string, appBundleId: string): string[] {
  const escapedPackage = escapeRegExp(appBundleId);
  const patterns = [
    new RegExp(`\\bStart proc\\s+(\\d+):${escapedPackage}(?:\\b|/)`, 'i'),
    new RegExp(`\\b(\\d+):${escapedPackage}(?:\\b|/)`, 'i'),
    new RegExp(`${escapedPackage}.*?\\bpid\\s*[=:]?\\s*(\\d+)\\b`, 'i'),
    new RegExp(`\\bpid\\s*[=:]?\\s*(\\d+)\\b.*${escapedPackage}`, 'i'),
  ];
  const results: string[] = [];
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    const pid = match?.[1];
    if (pid && /^\d+$/.test(pid)) {
      results.push(pid);
    }
  }
  return results;
}

function filterAndroidLogcatToPids(content: string, appBundleId: string, pids: string[]): string {
  const pidSet = new Set(pids);
  return content
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false;
      if (line.includes(appBundleId)) return true;
      const linePid = parseAndroidThreadtimePid(line);
      return linePid ? pidSet.has(linePid) : false;
    })
    .join('\n');
}

function parseAndroidThreadtimePid(line: string): string | null {
  const match = /\(\s*(\d+)\)\s*:/.exec(line);
  return match?.[1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
