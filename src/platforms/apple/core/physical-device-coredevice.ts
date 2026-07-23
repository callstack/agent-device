import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { execFailureDetails } from '../../../utils/exec.ts';
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

export async function ensureCoreDeviceReady(device: DeviceInfo): Promise<void> {
  try {
    const probe = await runCoreDeviceDetails(
      device.id,
      IOS_DEVICE_READY_TIMEOUT_MS,
      IOS_DEVICE_READY_COMMAND_TIMEOUT_BUFFER_MS,
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
  if (typeof timeoutBudgetMs === 'number' && timeoutBudgetMs <= 0) return null;
  const timeoutMs =
    typeof timeoutBudgetMs === 'number'
      ? Math.max(1, Math.min(IOS_RUNNER_DEVICE_INFO_TIMEOUT_MS, timeoutBudgetMs))
      : IOS_RUNNER_DEVICE_INFO_TIMEOUT_MS;
  try {
    const probe = await runCoreDeviceDetails(device.id, timeoutMs);
    if (probe.result.exitCode !== 0 || !probe.parsed.parsed) return null;
    if (probe.parsed.outcome && probe.parsed.outcome !== 'success') return null;
    return probe.parsed.tunnelIp ?? null;
  } catch {
    return null;
  }
}

async function runCoreDeviceDetails(
  deviceId: string,
  timeoutMs: number,
  commandTimeoutBufferMs = 0,
): Promise<{
  result: Awaited<ReturnType<typeof runXcrun>>;
  parsed: { parsed: boolean; outcome?: string; tunnelState?: string; tunnelIp?: string };
}> {
  const jsonPath = path.join(
    os.tmpdir(),
    `agent-device-coredevice-info-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
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
        timeoutMs: timeoutMs + commandTimeoutBufferMs,
      },
    );
    return { result, parsed: await readCoreDeviceDetails(jsonPath) };
  } finally {
    await fs.rm(jsonPath, { force: true }).catch(() => {});
  }
}

async function readCoreDeviceDetails(
  jsonPath: string,
): Promise<{ parsed: boolean; outcome?: string; tunnelState?: string; tunnelIp?: string }> {
  try {
    const payload = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as unknown;
    const details = parseIosDeviceDetailsPayload(payload);
    return { parsed: true, ...details };
  } catch {
    return { parsed: false };
  }
}

export function parseIosDeviceDetailsPayload(payload: unknown): {
  outcome?: string;
  tunnelState?: string;
  tunnelIp?: string;
} {
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
  const outcome = readNonEmptyString(
    (payload as { info?: { outcome?: unknown } } | null | undefined)?.info?.outcome,
  );
  return {
    ...(outcome ? { outcome } : {}),
    ...(tunnelState ? { tunnelState } : {}),
    ...(tunnelIp ? { tunnelIp } : {}),
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
