import type {
  HostCommandRequest,
  HostCommandResult,
  NetworkDumpInput,
  NetworkDumpResult,
  PlatformRuntimeHost,
} from '@agent-device/contracts/platform';
import { mergeNetworkDumps, readRecentNetworkTrafficFromText } from '@agent-device/capture-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { assertAndroidLogPackageSafe } from '../logs/package-name.ts';

type RecoveryContext = Readonly<{
  reason: 'inactive' | 'stale-active';
  trackedPid?: string;
}>;

export async function dumpAndroidNetworkTraffic(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: NetworkDumpInput,
  signal: AbortSignal,
): Promise<NetworkDumpResult> {
  const recent = await host.appLogs.readRecent(input.sessionId, input.maxScanLines);
  let dump = readRecentNetworkTrafficFromText(recent.text, {
    ...input,
    path: recent.path,
    exists: recent.exists,
    lineNumberOffset: recent.skippedLines,
    backend: 'android',
  });
  const notes: string[] = [];
  const context = await recoveryContext(host, device, input, signal);
  if (context && input.appBundleId) {
    assertAndroidLogPackageSafe(input.appBundleId);
    const recovered = await recoverPackageTraffic(host, device, input.appBundleId, signal);
    if (recovered) {
      const recoveryDump = readRecentNetworkTrafficFromText(recovered.text, {
        ...input,
        path: `${recent.path} (adb logcat recovery)`,
        exists: true,
        backend: 'android',
      });
      if (recoveryDump.entries.length > 0) {
        dump = mergeNetworkDumps(recoveryDump, dump, input.maxEntries);
        notes.push(
          context.reason === 'stale-active'
            ? `Session app log stream was still bound to prior Android PID ${context.trackedPid}. Recovered recent Android HTTP entries from adb logcat for PID set ${recovered.pids.join(', ')}.`
            : `Session app log stream was inactive. Recovered recent Android HTTP entries from adb logcat for PID set ${recovered.pids.join(', ')}.`,
        );
      }
    }
  }
  if (!input.appLogSnapshot) {
    notes.push(
      'Capture uses the session app log file. For fresh traffic, run logs clear --restart before reproducing requests.',
    );
  } else if (input.appLogSnapshot.state !== 'active' && notes.length === 0) {
    notes.push(
      'Session app log stream is inactive. Run logs clear --restart, reproduce the request window again, then rerun network dump.',
    );
  }
  if (dump.entries.length === 0) {
    notes.push('No HTTP(s) entries were found in recent session app logs.');
  }
  return Object.freeze({
    source: 'app-log',
    backend: 'android',
    dump,
    notes: Object.freeze(notes),
  });
}

async function runOptionalRecoveryCommand(
  host: PlatformRuntimeHost,
  request: HostCommandRequest,
  signal: AbortSignal,
): Promise<HostCommandResult | undefined> {
  signal.throwIfAborted();
  try {
    const result = await host.commands.run(request, signal);
    signal.throwIfAborted();
    return result;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

async function recoveryContext(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: NetworkDumpInput,
  signal: AbortSignal,
): Promise<RecoveryContext | undefined> {
  if (!input.appBundleId) return undefined;
  if (input.appLogSnapshot?.state === undefined) return undefined;
  if (input.appLogSnapshot.state !== 'active') return { reason: 'inactive' };
  const marker = await host.appLogs.readProcessMarker(input.sessionId);
  const trackedPid = trackedAndroidPid(marker);
  if (!trackedPid) return undefined;
  const currentPid = await resolveAndroidPid(host, device.id, input.appBundleId, signal);
  if (!currentPid || currentPid === trackedPid) return undefined;
  return { reason: 'stale-active', trackedPid };
}

function trackedAndroidPid(
  marker: Awaited<ReturnType<PlatformRuntimeHost['appLogs']['readProcessMarker']>>,
): string | undefined {
  if (marker.status !== 'decoded') return undefined;
  return /(?:^|\s)--pid\s+(\d+)(?:\s|$)/.exec(marker.marker.command)?.[1];
}

async function recoverPackageTraffic(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  appBundleId: string,
  signal: AbortSignal,
): Promise<{ text: string; pids: readonly string[] } | undefined> {
  const currentPid = await resolveAndroidPid(host, device.id, appBundleId, signal);
  const result = await runOptionalRecoveryCommand(
    host,
    {
      executable: 'adb',
      args: ['-s', device.id, 'logcat', '-d', '-v', 'time', '-t', '4000'],
      allowFailure: true,
      timeoutMs: 3_000,
    },
    signal,
  );
  if (!result) return undefined;
  if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;
  const pids = collectPackagePids(result.stdout, appBundleId, currentPid);
  if (pids.length === 0) return undefined;
  const pidSet = new Set(pids);
  const text = result.stdout
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false;
      if (line.includes(appBundleId)) return true;
      const pid = /\(\s*(\d+)\)\s*:/.exec(line)?.[1];
      return Boolean(pid && pidSet.has(pid));
    })
    .join('\n');
  return text.trim() ? { text, pids } : undefined;
}

async function resolveAndroidPid(
  host: PlatformRuntimeHost,
  deviceId: string,
  appBundleId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await runOptionalRecoveryCommand(
    host,
    {
      executable: 'adb',
      args: ['-s', deviceId, 'shell', 'pidof', appBundleId],
      allowFailure: true,
    },
    signal,
  );
  if (!result) return undefined;
  const pid = result.stdout.trim().split(/\s+/)[0];
  return pid && /^\d+$/.test(pid) ? pid : undefined;
}

function collectPackagePids(
  text: string,
  appBundleId: string,
  currentPid: string | undefined,
): readonly string[] {
  const pids = new Set<string>(currentPid ? [currentPid] : []);
  const packagePattern = appBundleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\bStart proc\\s+(\\d+):${packagePattern}(?:\\b|/)`, 'i'),
    new RegExp(`\\b(\\d+):${packagePattern}(?:\\b|/)`, 'i'),
    new RegExp(`${packagePattern}.*?\\bpid\\s*[=:]?\\s*(\\d+)\\b`, 'i'),
    new RegExp(`\\bpid\\s*[=:]?\\s*(\\d+)\\b.*${packagePattern}`, 'i'),
  ];
  for (const line of text.split('\n')) {
    if (!line.includes(appBundleId)) continue;
    for (const pattern of patterns) {
      const pid = pattern.exec(line)?.[1];
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }
  }
  return Object.freeze([...pids]);
}
