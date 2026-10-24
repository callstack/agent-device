import type { NetworkDump } from '@agent-device/contracts/network-traffic';
import type { NetworkDumpInput, NetworkDumpResult } from '@agent-device/contracts/network-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import {
  mergeNetworkScans,
  readRecentNetworkTrafficFromText,
  type NetworkScan,
} from '@agent-device/capture-kit';
import {
  captureNetworkProviderTraffic,
  scanNetworkAppLogFallback,
} from '@agent-device/capture-kit/network-provider-capture';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import {
  scopeSimctlArgsForDevice,
  simctlListBootedArgsForSet,
  readSimctlBootedNames,
} from '../core/simctl.ts';
import {
  isSupportedAppleDevicectlDevice,
  type DevicectlAppleDevice,
} from '../inventory-classification.ts';
import { backendForAppleDevice } from '../logs/backend.ts';

const IDENTITY_SETS_ROOT_ENV = 'AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET';
const IDENTITY_PROBE_TIMEOUT_MS = 4_000;

/**
 * The dev server's device name of this one simulator, or nothing when the name is not an identity.
 * The dev server names an Apple runtime after the simulator's display name, so the name joins only
 * when no other booted simulator on this host carries it — in this set or any other set the host
 * can name — and no connected physical device is named the same. A shared name could select, hook
 * and drain the other device's runtime. Any listing, physical-device answer, or set enumeration
 * that cannot be read fails the identity closed. Simulators kept in set directories this host was
 * never told about cannot be listed by any tool; that residue is the accepted risk of ADR 0038.
 */
async function metroDeviceIdentity(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator') return undefined;
  const sets = await identitySetPaths(host, device);
  if (sets === undefined) return undefined;
  const sameName = [];
  for (const setPath of sets) {
    const result = await host.appleTools.run(
      {
        tool: 'simctl',
        args: simctlListBootedArgsForSet(setPath),
        allowFailure: true,
        timeoutMs: IDENTITY_PROBE_TIMEOUT_MS,
      },
      signal,
    );
    if (result.exitCode !== 0) return undefined;
    let names: string[];
    try {
      names = readSimctlBootedNames(result.stdout);
    } catch {
      return undefined;
    }
    sameName.push(...names.filter((name) => name === device.name));
  }
  if (sameName.length !== 1) return undefined;
  const otherNames = await connectedOtherDeviceNames(host, device, signal);
  if (otherNames === undefined) return undefined;
  if (otherNames.some((name) => name === device.name)) return undefined;
  return device.name;
}

/**
 * Every simulator set this host can name: the device's own set, the default set, and the set the
 * daemon operator configured. An enumeration that cannot conclude returns undefined: with
 * `AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET` set, requests use only the operator's set and the
 * identity must be proven there, so a device outside it is an unnameable host state.
 */
async function identitySetPaths(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
): Promise<readonly (string | undefined)[] | undefined> {
  const deviceSet = device.simulatorSetPath?.trim() || undefined;
  const operatorSet = host.hostEnvironment.env[IDENTITY_SETS_ROOT_ENV]?.trim() || undefined;
  if (operatorSet !== undefined && operatorSet !== deviceSet) return undefined;
  if (deviceSet === undefined) return [undefined];
  return [deviceSet, undefined];
}

/**
 * The names of connected devices devicectl reports under another udid than the session's — a
 * same-named physical device could attach to the same dev server, and CoreDevice also registers
 * booted simulators, so a same-named simulator this host's set listings never showed still shows
 * here. A devicectl that fails, times out, or whose answer cannot be read returns undefined:
 * unknown devices fail the identity closed.
 */
async function connectedOtherDeviceNames(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<readonly string[] | undefined> {
  let file;
  try {
    file = await host.temporaryFiles.create({
      prefix: 'agent-device-network-identity-',
      suffix: '.json',
    });
    const result = await host.appleTools.run(
      {
        tool: 'devicectl',
        args: ['list', 'devices', '--json-output', file.path],
        allowFailure: true,
        timeoutMs: IDENTITY_PROBE_TIMEOUT_MS,
      },
      signal,
    );
    if (result.exitCode !== 0) return undefined;
    const payload = JSON.parse(await file.readText()) as {
      result?: { devices?: DevicectlAppleDevice[] };
    };
    const devices = payload.result?.devices;
    if (!Array.isArray(devices)) return undefined;
    return devices
      .filter(
        (entry) =>
          isSupportedAppleDevicectlDevice(entry) &&
          entry.connectionProperties?.tunnelState === 'connected' &&
          (entry.hardwareProperties?.udid ?? entry.identifier) !== device.id,
      )
      .map((entry) => entry.name ?? entry.deviceProperties?.name ?? '');
  } catch {
    return undefined;
  } finally {
    try {
      await file?.[Symbol.asyncDispose]();
    } catch {
      // An unreadable answer already failed the identity closed; cleanup must not mask that.
    }
  }
}

export async function dumpAppleNetworkTraffic(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: NetworkDumpInput,
  signal: AbortSignal,
): Promise<NetworkDumpResult> {
  const backend = backendForAppleDevice(device);
  // The identity probe costs simctl and devicectl calls, so it rides into the transport as a
  // resolver and only a dump that reached a Metro binding pays for it.
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
  const fallback = await scanNetworkAppLogFallback(host, input, backend);
  let scan = fallback.scan;
  // Lifecycle and scan notes describe the app-log source alone; provider notes join last, so an
  // arming or unavailable note never hides the inactive-stream guidance.
  const notes: string[] = [];
  if (canRecoverSimulator(device, input, scan.dump)) {
    const recovery = await recoverSimulatorTraffic(
      host,
      device,
      input,
      fallback.recent.path,
      signal,
    );
    if (recovery) scan = mergeRecoveredTraffic(notes, scan, recovery, input.maxEntries);
  }
  appendLifecycleNote(notes, device, input);
  appendUnnamedRequestNote(notes, scan.dump);
  if (scan.dump.entries.length === 0) notes.push(noEntriesNote(device));
  notes.push(...provider.notes);
  return Object.freeze({
    source: 'app-log',
    backend,
    dump: scan.dump,
    notes: Object.freeze(notes),
  });
}

/**
 * Traffic the recovery pass saw but could not name is still traffic, so it is
 * merged for its count alone; only a pass that found nothing at all reports the
 * window as non-network.
 */
function mergeRecoveredTraffic(
  notes: string[],
  scan: NetworkScan,
  recovery: { scan: NetworkScan; lineCount: number },
  maxEntries: number,
): NetworkScan {
  const recovered = recovery.scan.dump.entries.length;
  if (recovered === 0 && (recovery.scan.dump.unnamedRequests ?? 0) === 0) {
    if (recovery.lineCount > 0) {
      notes.push(
        `Recovered ${recovery.lineCount} recent iOS simulator app log lines from simctl log show, but none looked like HTTP traffic. This app may not emit request URLs, status, or timing into Unified Logging for this repro window.`,
      );
    }
    return scan;
  }
  if (recovered > 0) {
    notes.push(
      `Recovered ${recovered} iOS simulator HTTP entr${recovered === 1 ? 'y' : 'ies'} from simctl log show (${recovery.lineCount} app log lines scanned).`,
    );
  }
  return mergeNetworkScans(recovery.scan, scan, maxEntries);
}

function canRecoverSimulator(
  device: DeviceInfo,
  input: NetworkDumpInput,
  dump: NetworkDump,
): boolean {
  return (
    isIosFamily(device) &&
    device.kind === 'simulator' &&
    Boolean(input.appBundleId) &&
    dump.entries.length === 0
  );
}

async function recoverSimulatorTraffic(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: NetworkDumpInput,
  appLogPath: string,
  signal: AbortSignal,
): Promise<{ scan: NetworkScan; lineCount: number } | undefined> {
  const startedAt = input.appLogSnapshot?.startedAt;
  const args = scopeSimctlArgsForDevice(device, [
    'spawn',
    device.id,
    'log',
    'show',
    '--style',
    'compact',
    '--info',
    '--predicate',
    buildPredicate(input.appBundleId as string),
    ...(typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0
      ? ['--start', `@${Math.floor(startedAt / 1000)}`]
      : ['--last', '5m']),
  ]);
  const result = await host.appleTools.run(
    { tool: 'simctl', args, allowFailure: true, timeoutMs: 4_000 },
    signal,
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;
  const lines = result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line.trim() && !line.trim().startsWith('Timestamp               Ty Process[PID:TID]'),
    );
  if (lines.length === 0) return undefined;
  return {
    scan: readRecentNetworkTrafficFromText(`${lines.join('\n')}\n`, {
      ...input,
      path: `${appLogPath} (simctl log show recovery)`,
      exists: true,
      backend: 'ios-simulator',
    }),
    lineCount: lines.length,
  };
}

function buildPredicate(appBundleId: string): string {
  const value = appBundleId.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`);
  return [
    `subsystem == "${value}"`,
    `subsystem CONTAINS "${value}"`,
    `processImagePath ENDSWITH[c] "/${value}"`,
    `senderImagePath ENDSWITH[c] "/${value}"`,
  ].join(' OR ');
}

/**
 * CFNetwork logs a request URL only when a connection is opened, so a request
 * that reused a keep-alive connection is reported against its connection's
 * origin with no path. Saying so keeps "this endpoint was never called" from
 * being read off a dump that could not name every request it observed.
 */
function appendUnnamedRequestNote(notes: string[], dump: NetworkDump): void {
  const againstOrigin = dump.entries.filter((entry) => entry.pathUnavailable).length;
  const unresolved = dump.unnamedRequests ?? 0;
  const observed = againstOrigin + unresolved;
  if (observed === 0) return;
  const parts = [
    `${observed} request${observed === 1 ? '' : 's'} reused a keep-alive connection, so CFNetwork logged no request URL.`,
  ];
  if (againstOrigin > 0) {
    parts.push(
      `${againstOrigin} listed against the origin the connection was opened for, without a path.`,
    );
  }
  if (unresolved > 0) {
    parts.push(
      `${unresolved} opened before this scan window and are missing from the entries entirely; scan more lines, or run logs clear --restart before the repro.`,
    );
  }
  parts.push('Absence of an endpoint in this dump does not prove it was not called.');
  notes.push(parts.join(' '));
}

function appendLifecycleNote(notes: string[], device: DeviceInfo, input: NetworkDumpInput): void {
  if (!input.appLogSnapshot) {
    notes.push(
      'Capture uses the session app log file. For fresh traffic, run logs clear --restart before reproducing requests.',
    );
  } else if (input.appLogSnapshot.state !== 'active' && notes.length === 0) {
    notes.push(
      isIosFamily(device) && device.kind === 'simulator'
        ? 'Session app log stream is inactive. The iOS simulator recovery path scanned recent simctl log history, but a fresh logs clear --restart window is still the most reliable repro loop.'
        : 'Session app log stream is inactive. Run logs clear --restart, reproduce the request window again, then rerun network dump.',
    );
  }
}

function noEntriesNote(device: DeviceInfo): string {
  if (isIosFamily(device) && device.kind === 'simulator') {
    return 'No HTTP(s) entries were found in recent iOS simulator app logs. If the app only emits non-HTTP diagnostics, inspect logs path or add app-side URLSession/network logging for per-request timing and payload details.';
  }
  if (isIosFamily(device)) {
    return 'No HTTP(s) entries were found in recent iOS device app logs. iOS network dump only sees what the app emits into Unified Logging for this process.';
  }
  return 'No HTTP(s) entries were found in recent session app logs.';
}
