import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';
import {
  hostTemporaryDirectory,
  readHostTextFile,
  removeHostPath,
} from '@agent-device/host-kit/host-file';
import { hostProcessId } from '@agent-device/host-kit/process';
import {
  IOS_DEVICECTL_DEFAULT_HINT,
  resolveIosDevicectlHint,
  runIosDevicectl,
} from './devicectl.ts';
import {
  IOS_DEVICE_READY_COMMAND_TIMEOUT_BUFFER_MS,
  IOS_DEVICE_READY_TIMEOUT_MS,
} from './physical-device-constants.ts';
import { runXcrun } from './tool-provider.ts';

const IOS_RUNNER_DEVICE_INFO_TIMEOUT_MS = 10_000;

export async function launchCoreDeviceApp(
  device: DeviceInfo,
  bundleId: string,
  options: { payloadUrl?: string; launchArgs?: string[] } = {},
): Promise<void> {
  const args = ['device', 'process', 'launch', '--device', device.id, bundleId];
  if (options.payloadUrl) {
    args.push('--payload-url', options.payloadUrl);
  }
  if (options.launchArgs && options.launchArgs.length > 0) {
    // `devicectl` uses Swift ArgumentParser; preserve app-owned leading dashes.
    args.push('--', ...options.launchArgs);
  }
  await runIosDevicectl(args, { action: 'launch iOS app', deviceId: device.id });
}

export async function ensureCoreDeviceReady(
  device: DeviceInfo,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const probe = await runCoreDeviceDetails(
      device.id,
      IOS_DEVICE_READY_TIMEOUT_MS,
      IOS_DEVICE_READY_COMMAND_TIMEOUT_BUFFER_MS,
      signal,
    );
    const { result, parsed } = probe;
    if (result.exitCode === 0) {
      if (!parsed.parsed) {
        throw new AppError('COMMAND_FAILED', 'iOS device readiness probe failed', {
          kind: 'probe_inconclusive',
          deviceId: device.id,
          stdout: result.stdout,
          stderr: result.stderr,
          hint: 'CoreDevice returned success but readiness JSON output was missing or invalid. Retry; if it persists restart Xcode and the iOS device.',
        });
      }
      const tunnelState = parsed.tunnelState?.toLowerCase();
      if (tunnelState === 'connecting') {
        throw new AppError('COMMAND_FAILED', 'iOS device is not ready for automation', {
          kind: 'not_ready',
          deviceId: device.id,
          tunnelState,
          hint: 'Device tunnel is still connecting. Keep the device unlocked and connected by cable until it is fully available in Xcode Devices, then retry.',
        });
      }
      return;
    }
    throw new AppError(
      'COMMAND_FAILED',
      'iOS device is not ready for automation',
      execFailureDetails(result, {
        kind: 'not_ready',
        deviceId: device.id,
        tunnelState: parsed.tunnelState,
        hint: resolveIosReadyHint(result.stdout, result.stderr),
      }),
    );
  } catch (error) {
    throw normalizeCoreDeviceReadyError(device.id, error);
  }
}

function normalizeCoreDeviceReadyError(deviceId: string, error: unknown): AppError {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') {
    return buildUnexpectedCoreDeviceReadyError(deviceId, error);
  }
  const kind = typeof error.details?.kind === 'string' ? error.details.kind : '';
  if (kind === 'not_ready') return error;
  return normalizeCoreDeviceProbeError(deviceId, error);
}

function normalizeCoreDeviceProbeError(deviceId: string, error: AppError): AppError {
  const details = (error.details ?? {}) as {
    stdout?: string;
    stderr?: string;
    timeoutMs?: number;
  };
  const stdout = String(details.stdout ?? '');
  const stderr = String(details.stderr ?? '');
  const timeoutMs = Number(details.timeoutMs ?? IOS_DEVICE_READY_TIMEOUT_MS);
  const timeoutHint = `CoreDevice did not respond within ${timeoutMs}ms. Keep the device unlocked and trusted, then retry; if it persists restart Xcode and the iOS device.`;
  return new AppError(
    'COMMAND_FAILED',
    'iOS device readiness probe failed',
    {
      deviceId,
      cause: error.message,
      timeoutMs,
      stdout,
      stderr,
      hint: stdout || stderr ? resolveIosReadyHint(stdout, stderr) : timeoutHint,
    },
    error,
  );
}

function buildUnexpectedCoreDeviceReadyError(deviceId: string, error: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'iOS device readiness probe failed',
    {
      deviceId,
      hint: 'Reconnect the device, keep it unlocked, and retry.',
    },
    error instanceof Error ? error : undefined,
  );
}

export async function resolveCoreDeviceTunnelIp(
  device: DeviceInfo,
  timeoutBudgetMs?: number,
): Promise<string | null> {
  const details = await readIosDeviceDetails(
    device,
    timeoutBudgetMs ?? IOS_RUNNER_DEVICE_INFO_TIMEOUT_MS,
  );
  return details?.tunnelIp ?? null;
}

/**
 * The device's own report, or `null` when CoreDevice could not answer it. Callers that need a
 * verdict out of these fields read it here rather than re-running the tool: this is the one place
 * that spells the command out, and an unreadable device stays unreadable instead of becoming an
 * assumption about what is wrong with it (#2683).
 */
export async function readIosDeviceDetails(
  device: DeviceInfo,
  timeoutBudgetMs: number,
  signal?: AbortSignal,
): Promise<IosDeviceDetails | null> {
  if (!(timeoutBudgetMs > 0)) return null;
  const timeoutMs = Math.max(1, Math.min(IOS_RUNNER_DEVICE_INFO_TIMEOUT_MS, timeoutBudgetMs));
  try {
    const probe = await runCoreDeviceDetails(device.id, timeoutMs, 0, signal);
    if (probe.result.exitCode !== 0 || !probe.parsed.parsed) return null;
    if (probe.parsed.outcome && probe.parsed.outcome !== 'success') return null;
    const { parsed } = probe;
    const { parsed: _parsed, ...details } = parsed;
    return details;
  } catch {
    return null;
  }
}

async function runCoreDeviceDetails(
  deviceId: string,
  timeoutMs: number,
  commandTimeoutBufferMs = 0,
  signal?: AbortSignal,
): Promise<{
  result: Awaited<ReturnType<typeof runXcrun>>;
  parsed: { parsed: boolean } & IosDeviceDetails;
}> {
  const jsonPath = path.join(
    hostTemporaryDirectory(),
    `agent-device-coredevice-info-${hostProcessId()}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  try {
    const result = await runXcrun(
      [
        'devicectl',
        'device',
        'info',
        'details',
        '--device',
        deviceId,
        '--json-output',
        jsonPath,
        '--timeout',
        String(timeoutSeconds),
      ],
      {
        allowFailure: true,
        signal,
        timeoutMs: timeoutMs + commandTimeoutBufferMs,
      },
    );
    return { result, parsed: await readCoreDeviceDetails(jsonPath) };
  } finally {
    await removeHostPath(jsonPath).catch(() => {});
  }
}

async function readCoreDeviceDetails(
  jsonPath: string,
): Promise<{ parsed: boolean } & IosDeviceDetails> {
  try {
    const payload = JSON.parse(await readHostTextFile(jsonPath)) as unknown;
    const details = parseIosDeviceDetailsPayload(payload);
    return { parsed: true, ...details };
  } catch {
    return { parsed: false };
  }
}

/**
 * What one `devicectl device info details` payload reports (#2683). Every field is the tool's own
 * value, copied rather than interpreted: whether Developer Mode is on, and whether the device
 * exposes developer disk image services, are two separate answers the device gives, and a reader
 * that turns them into a verdict has to be able to see that one arrived and the other did not.
 */
export type IosDeviceDetails = {
  outcome?: string;
  tunnelState?: string;
  tunnelIp?: string;
  /** `deviceProperties.developerModeStatus`, spelled as CoreDevice spells it. */
  developerModeStatus?: string;
  /** `deviceProperties.ddiServicesAvailable`, which is what the device says about its developer disk image. */
  developerDiskImageServicesAvailable?: boolean;
};

export function parseIosDeviceDetailsPayload(payload: unknown): IosDeviceDetails {
  const result = (payload as { result?: unknown } | null | undefined)?.result;
  if (!result || typeof result !== 'object') return {};
  const direct = (
    result as {
      connectionProperties?: { tunnelState?: unknown; tunnelIPAddress?: unknown };
    }
  ).connectionProperties;
  const nested = (
    result as {
      device?: { connectionProperties?: { tunnelState?: unknown; tunnelIPAddress?: unknown } };
    }
  ).device?.connectionProperties;
  const tunnelState =
    readNonEmptyString(direct?.tunnelState) ?? readNonEmptyString(nested?.tunnelState);
  const tunnelIp =
    readNonEmptyString(direct?.tunnelIPAddress) ?? readNonEmptyString(nested?.tunnelIPAddress);
  const deviceProperties = readDeviceProperties(result);
  const developerModeStatus =
    readNonEmptyString(deviceProperties?.developerModeStatus) ??
    readNonEmptyString(nestedDevice(result)?.deviceProperties?.developerModeStatus);
  const developerDiskImageServicesAvailable =
    readBoolean(deviceProperties?.ddiServicesAvailable) ??
    readBoolean(nestedDevice(result)?.deviceProperties?.ddiServicesAvailable);
  const outcome = readNonEmptyString(
    (payload as { info?: { outcome?: unknown } } | null | undefined)?.info?.outcome,
  );
  return {
    ...(outcome ? { outcome } : {}),
    ...(tunnelState ? { tunnelState } : {}),
    ...(tunnelIp ? { tunnelIp } : {}),
    ...(developerModeStatus ? { developerModeStatus } : {}),
    ...(developerDiskImageServicesAvailable === undefined
      ? {}
      : { developerDiskImageServicesAvailable }),
  };
}

function readDeviceProperties(
  result: object,
): { developerModeStatus?: unknown; ddiServicesAvailable?: unknown } | undefined {
  const properties = (result as { deviceProperties?: unknown }).deviceProperties;
  return properties && typeof properties === 'object'
    ? (properties as { developerModeStatus?: unknown; ddiServicesAvailable?: unknown })
    : undefined;
}

function nestedDevice(
  result: object,
):
  | { deviceProperties?: { developerModeStatus?: unknown; ddiServicesAvailable?: unknown } }
  | undefined {
  const device = (result as { device?: unknown }).device;
  return device && typeof device === 'object'
    ? (device as {
        deviceProperties?: { developerModeStatus?: unknown; ddiServicesAvailable?: unknown };
      })
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * The device's own report on whether it can host development tooling (#2683), published through the
 * physical-device control facet. `runner/host.ts` mirrors this shape structurally on its side of the
 * host port.
 *
 * The two states are kept apart because the device reports them apart and they fail apart. A device
 * with Developer Mode off cannot serve its developer disk image either; an image that is not up on a
 * device with the toggle on is its own failure. Deciding which one to name is the reader's job in
 * `runner/runner-device-readiness.ts`, beside the rules and hints that name them.
 *
 * `available: false` is the answer when the device could not be reached at all. It carries no
 * verdict — an unreadable device is not a diagnosed one — only the way to read it again.
 */
export type IosDeviceReadiness =
  | Readonly<{
      available: true;
      developerMode: IosDeveloperModeState;
      developerDiskImage: IosDeveloperDiskImageState;
    }>
  | Readonly<{
      available: false;
      reason: 'device_readiness_unreadable';
      hint: string;
    }>;

/** How a device reports its own Settings > Privacy & Security > Developer Mode toggle. */
export type IosDeveloperModeState = 'enabled' | 'disabled' | 'unknown';

/** How a device reports the services that serve its developer disk image. */
export type IosDeveloperDiskImageState = 'available' | 'unavailable' | 'unknown';

const IOS_DEVICE_READINESS_TIMEOUT_MS = 10_000;

/**
 * What a device whose report could not be read needs: a way to read it, and no diagnosis. No fact
 * means no claim, so this shape never names a cause (#2683).
 */
const IOS_DEVICE_READINESS_UNREADABLE_HINT =
  'Read the device state directly with `xcrun devicectl device info details --device <id> --json-output -`, keeping the device unlocked and connected by cable, then retry.';

/**
 * The device's own answer to "can this iPhone run development tooling right now" (#2683).
 *
 * This reads and never interprets: `developerModeStatus` is the owner's toggle in Settings >
 * Privacy & Security > Developer Mode, and `ddiServicesAvailable` is whether the device exposes
 * developer disk image services. Both are copied into their own field so the reader that draws a
 * verdict can tell that one arrived and the other did not, which is what stops an image complaint
 * from being answered as a toggle problem. What the states mean for a runner is decided by
 * `runner/runner-device-readiness.ts`, beside the rules and hints that name them.
 */
export async function readIosDeviceReadiness(
  device: DeviceInfo,
  timeoutBudgetMs = IOS_DEVICE_READINESS_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<IosDeviceReadiness> {
  const details = await readIosDeviceDetails(device, timeoutBudgetMs, signal);
  if (!details) {
    return {
      available: false,
      reason: 'device_readiness_unreadable',
      hint: IOS_DEVICE_READINESS_UNREADABLE_HINT,
    };
  }
  return {
    available: true,
    developerMode: readDeveloperModeState(details.developerModeStatus),
    developerDiskImage: readDeveloperDiskImageState(details.developerDiskImageServicesAvailable),
  };
}

/**
 * Only the two spellings CoreDevice uses are states. A missing key or a spelling we do not know
 * stays `unknown`: the point of asking the device is that we repeat what it said, so an answer we
 * cannot recognise cannot be read as either permission or accusation.
 */
function readDeveloperModeState(status: string | undefined): IosDeveloperModeState {
  const spelled = status?.toLowerCase();
  if (spelled === 'enabled') return 'enabled';
  if (spelled === 'disabled') return 'disabled';
  return 'unknown';
}

function readDeveloperDiskImageState(available: boolean | undefined): IosDeveloperDiskImageState {
  if (available === true) return 'available';
  if (available === false) return 'unavailable';
  return 'unknown';
}

export function resolveIosReadyHint(stdout: string, stderr: string): string {
  const devicectlHint = resolveIosDevicectlHint(stdout, stderr);
  if (devicectlHint) return devicectlHint;
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (text.includes('timed out waiting for all destinations')) {
    return 'Xcode destination did not become available in time. Keep device unlocked and retry.';
  }
  return IOS_DEVICECTL_DEFAULT_HINT;
}
