import type {
  HostCommandRequest,
  HostCommandResult,
} from '@agent-device/contracts/platform-runtime-host';
import type { NetworkDumpInput, NetworkDumpResult } from '@agent-device/contracts/network-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { mergeNetworkScans, readRecentNetworkTrafficFromText } from '@agent-device/capture-kit';
import {
  captureNetworkProviderTraffic,
  scanNetworkAppLogFallback,
} from '@agent-device/capture-kit/network-provider-capture';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { assertAndroidLogPackageSafe } from '../logs/package-name.ts';
import {
  parseAndroidListedDeviceEntries,
  type AndroidListedDeviceEntry,
} from '../inventory-parsers.ts';

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
  // The identity probe costs adb calls, so it rides into the transport as a resolver and only a
  // dump that reached a Metro binding pays for it.
  const provider = await captureNetworkProviderTraffic(
    host,
    device,
    input,
    signal,
    input.appBundleId === undefined
      ? {}
      : {
          resolveMetroDeviceIdentity: (dumpSignal: AbortSignal) =>
            metroDeviceIdentity(host, device, dumpSignal),
        },
  );
  if (provider.status === 'captured') {
    return Object.freeze({ source: 'provider', ...provider.result });
  }
  const fallback = await scanNetworkAppLogFallback(host, input, 'android');
  let scan = fallback.scan;
  // Lifecycle and scan notes describe the app-log source alone; provider notes join last, so an
  // arming or unavailable note never hides the inactive-stream guidance.
  const notes: string[] = [];
  const context = await recoveryContext(host, device, input, signal);
  if (context && input.appBundleId) {
    assertAndroidLogPackageSafe(input.appBundleId);
    const recovered = await recoverPackageTraffic(host, device, input.appBundleId, signal);
    if (recovered) {
      const recoveryScan = readRecentNetworkTrafficFromText(recovered.text, {
        ...input,
        path: `${fallback.recent.path} (adb logcat recovery)`,
        exists: true,
        backend: 'android',
      });
      if (recoveryScan.dump.entries.length > 0) {
        scan = mergeNetworkScans(recoveryScan, scan, input.maxEntries);
        notes.push(androidRecoveryNote(context, recovered.pids));
      }
    }
  }
  appendLifecycleNote(notes, input);
  if (scan.dump.entries.length === 0) {
    notes.push('No HTTP(s) entries were found in recent session app logs.');
  }
  notes.push(...provider.notes);
  return Object.freeze({
    source: 'app-log',
    backend: 'android',
    dump: scan.dump,
    notes: Object.freeze(notes),
  });
}

function androidRecoveryNote(context: RecoveryContext, pids: readonly string[]): string {
  return context.reason === 'stale-active'
    ? `Session app log stream was still bound to prior Android PID ${context.trackedPid}. Recovered recent Android HTTP entries from adb logcat for PID set ${pids.join(', ')}.`
    : `Session app log stream was inactive. Recovered recent Android HTTP entries from adb logcat for PID set ${pids.join(', ')}.`;
}

/**
 * The dev server's device name of this one device, or nothing when another attached device would
 * answer to it too. The dev server names an Android runtime `<Build.MODEL> - <release> - API
 * <level>`; `ro.product.model` and `ro.build.version.release` compose the same string, and
 * `ro.build.version.sdk` is the API level. Two devices of one system image share all three, so the
 * model joins only when the whole name is unique across attached devices; otherwise the provider
 * fails closed instead of reading and draining another device's runtime.
 */
async function metroDeviceIdentity(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<string | undefined> {
  const own = await readDeviceNameParts(host, device.id, signal);
  if (own === undefined) return undefined;
  const listed = await listAttachedDevices(host, signal);
  // The listing must state this session's own serial: a listing that omits an attached device is
  // an untrustworthy host view (a resetting adb server, a half-written listing), and one cannot
  // prove collisions against devices it hides.
  if (listed === undefined || !listed.some((entry) => entry.serial === device.id)) return undefined;
  for (const entry of listed) {
    if (entry.serial === device.id) continue;
    // Every other serial adb lists — offline or unauthorized included — must answer with its own
    // model. An unreadable serial is an unknown device, and an unknown device could share the
    // name, so the whole identity is withheld.
    const other = await readDeviceNameParts(host, entry.serial, signal);
    if (other === undefined || other.joined === own.joined) return undefined;
  }
  return own.joined;
}

const IDENTITY_PROBE_TIMEOUT_MS = 4_000;

async function readDeviceNameParts(
  host: PlatformRuntimeHost,
  serial: string,
  signal: AbortSignal,
): Promise<{ joined: string } | undefined> {
  const result = await runOptionalRecoveryCommand(
    host,
    {
      executable: 'adb',
      args: deviceShellArgv(
        'adb',
        'shell',
        [
          'sh',
          '-c',
          'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk',
        ],
        ['-s', serial],
      ),
      allowFailure: true,
      timeoutMs: IDENTITY_PROBE_TIMEOUT_MS,
    },
    signal,
  );
  if (!result || result.exitCode !== 0) return undefined;
  const [model, release, sdk] = result.stdout.split('\n').map((line) => line.trim());
  if (!model || !release || !sdk) return undefined;
  return { joined: `${model} - ${release} - API ${sdk}` };
}

async function listAttachedDevices(
  host: PlatformRuntimeHost,
  signal: AbortSignal,
): Promise<readonly AndroidListedDeviceEntry[] | undefined> {
  const result = await runOptionalRecoveryCommand(
    host,
    {
      executable: 'adb',
      args: ['devices'],
      allowFailure: true,
      timeoutMs: IDENTITY_PROBE_TIMEOUT_MS,
    },
    signal,
  );
  if (!result || result.exitCode !== 0) return undefined;
  return parseAndroidListedDeviceEntries(result.stdout);
}

function appendLifecycleNote(notes: string[], input: NetworkDumpInput): void {
  if (!input.appLogSnapshot) {
    notes.push(
      'Capture uses the session app log file. For fresh traffic, run logs clear --restart before reproducing requests.',
    );
  } else if (input.appLogSnapshot.state !== 'active' && notes.length === 0) {
    notes.push(
      'Session app log stream is inactive. Run logs clear --restart, reproduce the request window again, then rerun network dump.',
    );
  }
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
      args: deviceShellArgv('adb', 'shell', ['pidof', appBundleId], ['-s', deviceId]),
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
  const packagePattern = appBundleId.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
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
