import type { DeviceInfo } from '../kernel/device.ts';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AppError } from '../kernel/errors.ts';
import {
  resolveIosDevicectlHint,
  IOS_DEVICECTL_DEFAULT_HINT,
} from '../platforms/apple/core/devicectl.ts';
import { runXcrun } from '../platforms/apple/core/tool-provider.ts';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';

const IOS_DEVICE_READY_TIMEOUT_MS = 15_000;
const IOS_DEVICE_READY_COMMAND_TIMEOUT_BUFFER_MS = 3_000;

// Exported so unit tests can assert TTL behavior without duplicating the value.
export const DEVICE_READY_CACHE_TTL_MS = 5_000;

const readyCache = new Map<string, number>();

export type DeviceReadyOptions = {
  deviceHub?: boolean;
  focusExisting?: boolean;
  onIosSimulatorColdBootStart?: (device: DeviceInfo) => void;
};

export async function ensureDeviceReady(
  device: DeviceInfo,
  options: DeviceReadyOptions = {},
): Promise<void> {
  if (isActiveProviderDevice(device)) return;

  const cacheKey = deviceReadyCacheKey(device);
  const cachedUntil = readyCache.get(cacheKey);
  if (cachedUntil !== undefined) {
    if (cachedUntil > Date.now() && !options.focusExisting) {
      return;
    }
    readyCache.delete(cacheKey);
  }

  if (device.platform === 'ios') {
    if (device.kind === 'simulator') {
      const { ensureBootedSimulator } = await import('../platforms/apple/core/simulator.ts');
      await ensureBootedSimulator(device, {
        deviceHub: options.deviceHub,
        focusExisting: options.focusExisting,
        onColdBootStart: options.onIosSimulatorColdBootStart,
      });
      markDeviceReady(cacheKey);
      return;
    }
    if (device.kind === 'device') {
      await ensureIosDeviceReady(device.id);
      markDeviceReady(cacheKey);
      return;
    }
  }
  if (device.platform === 'android') {
    const { waitForAndroidBoot } = await import('../platforms/android/devices.ts');
    await waitForAndroidBoot(device.id);
    markDeviceReady(cacheKey);
  }
}

// Test-only reset hook for this daemon-local cache.
export function clearDeviceReadyCacheForTests(): void {
  readyCache.clear();
}

function markDeviceReady(cacheKey: string): void {
  readyCache.set(cacheKey, Date.now() + DEVICE_READY_CACHE_TTL_MS);
}

function deviceReadyCacheKey(device: DeviceInfo): string {
  const simulatorSetPath = device.kind === 'simulator' ? (device.simulatorSetPath ?? '') : '';
  return JSON.stringify([
    device.platform,
    device.kind,
    device.id,
    device.target ?? '',
    simulatorSetPath,
  ]);
}

async function ensureIosDeviceReady(deviceId: string): Promise<void> {
  const jsonPath = path.join(
    os.tmpdir(),
    `agent-device-ready-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  const timeoutSeconds = Math.max(1, Math.ceil(IOS_DEVICE_READY_TIMEOUT_MS / 1000));
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
        timeoutMs: IOS_DEVICE_READY_TIMEOUT_MS + IOS_DEVICE_READY_COMMAND_TIMEOUT_BUFFER_MS,
      },
    );
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    const parsed = await readIosReadyPayload(jsonPath);
    if (result.exitCode === 0) {
      if (!parsed.parsed) {
        throw new AppError('COMMAND_FAILED', 'iOS device readiness probe failed', {
          kind: 'probe_inconclusive',
          deviceId,
          stdout,
          stderr,
          hint: 'CoreDevice returned success but readiness JSON output was missing or invalid. Retry; if it persists restart Xcode and the iOS device.',
        });
      }
      const tunnelState = parsed?.tunnelState?.toLowerCase();
      if (tunnelState === 'connecting') {
        throw new AppError('COMMAND_FAILED', 'iOS device is not ready for automation', {
          kind: 'not_ready',
          deviceId,
          tunnelState,
          hint: 'Device tunnel is still connecting. Keep the device unlocked and connected by cable until it is fully available in Xcode Devices, then retry.',
        });
      }
      return;
    }
    throw new AppError('COMMAND_FAILED', 'iOS device is not ready for automation', {
      kind: 'not_ready',
      deviceId,
      stdout,
      stderr,
      exitCode: result.exitCode,
      tunnelState: parsed?.tunnelState,
      hint: resolveIosReadyHint(stdout, stderr),
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'COMMAND_FAILED') {
      const kind = typeof error.details?.kind === 'string' ? error.details.kind : '';
      if (kind === 'not_ready') {
        throw error;
      }
      const details = (error.details ?? {}) as {
        stdout?: string;
        stderr?: string;
        timeoutMs?: number;
      };
      const stdout = String(details.stdout ?? '');
      const stderr = String(details.stderr ?? '');
      const timeoutMs = Number(details.timeoutMs ?? IOS_DEVICE_READY_TIMEOUT_MS);
      const timeoutHint = `CoreDevice did not respond within ${timeoutMs}ms. Keep the device unlocked and trusted, then retry; if it persists restart Xcode and the iOS device.`;
      throw new AppError(
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
    throw new AppError(
      'COMMAND_FAILED',
      'iOS device readiness probe failed',
      {
        deviceId,
        hint: 'Reconnect the device, keep it unlocked, and retry.',
      },
      error instanceof Error ? error : undefined,
    );
  } finally {
    await fs.rm(jsonPath, { force: true }).catch(() => {});
  }
}

export function parseIosReadyPayload(payload: unknown): { tunnelState?: string } {
  const result = (payload as { result?: unknown } | null | undefined)?.result;
  if (!result || typeof result !== 'object') return {};
  const direct = (result as { connectionProperties?: { tunnelState?: unknown } })
    .connectionProperties?.tunnelState;
  const nested = (result as { device?: { connectionProperties?: { tunnelState?: unknown } } })
    .device?.connectionProperties?.tunnelState;
  const tunnelState =
    typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : undefined;
  return tunnelState ? { tunnelState } : {};
}

async function readIosReadyPayload(
  jsonPath: string,
): Promise<{ parsed: boolean; tunnelState?: string }> {
  try {
    const payloadText = await fs.readFile(jsonPath, 'utf8');
    const payload = JSON.parse(payloadText) as unknown;
    const parsed = parseIosReadyPayload(payload);
    return { parsed: true, tunnelState: parsed.tunnelState };
  } catch {
    return { parsed: false };
  }
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
