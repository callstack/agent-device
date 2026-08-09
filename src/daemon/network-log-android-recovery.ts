import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { androidDeviceForSerial } from '../platforms/android/adb.ts';
import { resolveAndroidAdbExecutor } from '../platforms/android/adb-executor.ts';
import { captureAndroidLogcatWithAdb } from '../platforms/android/logcat.ts';

type StoredNetworkLogProcessMeta = Readonly<{
  pid: number;
  command?: string;
}>;

export async function resolveAndroidPid(
  deviceId: string,
  appBundleId: string,
): Promise<string | null> {
  const pidResult = await resolveAndroidAdbExecutor(androidDeviceForSerial(deviceId))(
    ['shell', 'pidof', appBundleId],
    { allowFailure: true },
  );
  const pid = pidResult.stdout.trim().split(/\s+/)[0];
  return pid && /^\d+$/.test(pid) ? pid : null;
}

export function readTrackedAndroidLogcatPid(pidPath: string | undefined): string | null {
  const command = readStoredNetworkLogProcessMeta(pidPath)?.command;
  if (!command) return null;
  const match = /(?:^|\s)--pid\s+(\d+)(?:\s|$)/.exec(command);
  return match?.[1] ?? null;
}

function readStoredNetworkLogProcessMeta(
  pidPath: string | undefined,
): StoredNetworkLogProcessMeta | null {
  if (!pidPath) return null;
  const raw = readStoredNetworkLogProcessText(pidPath);
  if (raw === null || raw.length === 0 || /^\d+$/.test(raw)) return null;
  return decodeStoredNetworkLogProcessMeta(raw);
}

function readStoredNetworkLogProcessText(pidPath: string): string | null {
  try {
    return fs.readFileSync(pidPath, 'utf8').trim();
  } catch {
    return null;
  }
}

function decodeStoredNetworkLogProcessMeta(raw: string): StoredNetworkLogProcessMeta | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isUnknownRecord(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const pid = positiveInteger(record.pid);
    if (pid === null) return null;
    return {
      pid,
      ...(typeof record.command === 'string' ? { command: record.command } : {}),
    };
  } catch {
    return null;
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(value) && number > 0 ? number : null;
}

export async function readRecentAndroidLogcatForPackage(
  deviceId: string,
  appBundleId: string,
): Promise<{ pid: string | null; text: string; recoveredPids: string[] } | null> {
  assertAndroidNetworkPackageSafe(appBundleId);
  const pid = await resolveAndroidPid(deviceId, appBundleId);
  const adb = resolveAndroidAdbExecutor(androidDeviceForSerial(deviceId));
  const text = await captureAndroidLogcatWithAdb(adb, { lines: 4000, timeoutMs: 3_000 }).catch(
    () => '',
  );
  if (text.trim().length === 0) return null;
  const recoveredPids = collectAndroidPackagePids(text, appBundleId, pid);
  if (recoveredPids.length === 0) return null;
  const filteredText = filterAndroidLogcatToPids(text, appBundleId, recoveredPids);
  if (filteredText.trim().length === 0) return null;
  return { pid, text: filteredText, recoveredPids };
}

function assertAndroidNetworkPackageSafe(appBundleId: string): void {
  if (!/^[a-zA-Z0-9._:-]+$/.test(appBundleId)) {
    throw new AppError('INVALID_ARGS', `Invalid Android package name for logs: ${appBundleId}`);
  }
}

function collectAndroidPackagePids(
  content: string,
  appBundleId: string,
  currentPid: string | null,
): string[] {
  const pids = new Set<string>();
  if (currentPid) pids.add(currentPid);
  for (const line of content.split('\n')) {
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
    const pid = pattern.exec(line)?.[1];
    if (pid && /^\d+$/.test(pid)) results.push(pid);
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
  return /\(\s*(\d+)\)\s*:/.exec(line)?.[1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
