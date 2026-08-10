import type {
  NetworkDump,
  NetworkDumpInput,
  NetworkDumpResult,
  PlatformRuntimeHost,
} from '@agent-device/contracts/platform';
import { mergeNetworkDumps, readRecentNetworkTrafficFromText } from '@agent-device/capture-kit';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { backendForAppleDevice } from '../logs/backend.ts';

export async function dumpAppleNetworkTraffic(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: NetworkDumpInput,
  signal: AbortSignal,
): Promise<NetworkDumpResult> {
  const backend = backendForAppleDevice(device);
  const recent = await host.appLogs.readRecent(input.sessionId, input.maxScanLines);
  let dump = readRecentNetworkTrafficFromText(recent.text, {
    ...input,
    path: recent.path,
    exists: recent.exists,
    lineNumberOffset: recent.skippedLines,
    backend,
  });
  const notes: string[] = [];
  if (canRecoverSimulator(device, input, dump)) {
    const recovery = await recoverSimulatorTraffic(host, device, input, recent.path, signal);
    if (recovery) {
      if (recovery.dump.entries.length > 0) {
        dump = mergeNetworkDumps(recovery.dump, dump, input.maxEntries);
        notes.push(
          `Recovered ${recovery.dump.entries.length} iOS simulator HTTP entr${recovery.dump.entries.length === 1 ? 'y' : 'ies'} from simctl log show (${recovery.lineCount} app log lines scanned).`,
        );
      } else if (recovery.lineCount > 0) {
        notes.push(
          `Recovered ${recovery.lineCount} recent iOS simulator app log lines from simctl log show, but none looked like HTTP traffic. This app may not emit request URLs, status, or timing into Unified Logging for this repro window.`,
        );
      }
    }
  }
  appendLifecycleNote(notes, device, input);
  if (dump.entries.length === 0) notes.push(noEntriesNote(device));
  return Object.freeze({ source: 'app-log', backend, dump, notes: Object.freeze(notes) });
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
): Promise<{ dump: NetworkDump; lineCount: number } | undefined> {
  const args = [
    ...(device.simulatorSetPath ? ['--set', device.simulatorSetPath] : []),
    'spawn',
    device.id,
    'log',
    'show',
    '--style',
    'compact',
    '--info',
    '--predicate',
    buildPredicate(input.appBundleId as string),
  ];
  const startedAt = input.appLogSnapshot?.startedAt;
  args.push(
    ...(typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0
      ? ['--start', `@${Math.floor(startedAt / 1000)}`]
      : ['--last', '5m']),
  );
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
    dump: readRecentNetworkTrafficFromText(`${lines.join('\n')}\n`, {
      ...input,
      path: `${appLogPath} (simctl log show recovery)`,
      exists: true,
      backend: 'ios-simulator',
    }),
    lineCount: lines.length,
  };
}

function buildPredicate(appBundleId: string): string {
  const value = appBundleId.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return [
    `subsystem == "${value}"`,
    `subsystem CONTAINS "${value}"`,
    `processImagePath ENDSWITH[c] "/${value}"`,
    `senderImagePath ENDSWITH[c] "/${value}"`,
  ].join(' OR ');
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
