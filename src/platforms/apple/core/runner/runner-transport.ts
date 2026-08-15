import { createRequestCanceledError } from '../../../../request/cancel.ts';
import { AppError } from '@agent-device/kernel/errors';
import { Deadline } from '../../../../utils/retry.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveIosPhysicalDeviceControl } from '../physical-device-control.ts';
import { createRunnerCommandRouteResolver } from './runner-command-route.ts';
import { isUsbmuxDeviceUnattachedError, type RunnerCommand } from './runner-contract.ts';
import { usbmuxRunnerTransport } from './runner-usbmux.ts';

export const RUNNER_COMMAND_TIMEOUT_MS = 45_000;

export async function sendRunnerCommandOnce(
  device: DeviceInfo,
  port: number,
  command: RunnerCommand,
  timeoutMs: number = RUNNER_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) {
    throw createRequestCanceledError();
  }
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const resolver = createRunnerCommandRouteResolver(device, port);
  let route = await resolver.resolveRoute(deadline.remainingMs());
  if (route.kind === 'usbmux') {
    try {
      return await postUsbmuxRunnerCommand(device, port, command, deadline, signal);
    } catch (error) {
      if (!canFallBackFromUsbmux(device, error)) throw error;
      resolver.markUsbmuxUnattached();
      route = await resolver.resolveRoute(deadline.remainingMs());
    }
  }
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) {
    throw new AppError('COMMAND_FAILED', 'Runner command deadline exceeded', { timeoutMs });
  }
  const endpoint = route.endpoints[0];
  if (!endpoint) {
    throw new AppError('COMMAND_FAILED', 'Runner command endpoint not available', {
      port,
      endpoints: route.endpoints,
    });
  }
  return await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    },
    remainingMs,
    signal,
  );
}

async function postUsbmuxRunnerCommand(
  device: DeviceInfo,
  port: number,
  command: RunnerCommand,
  deadline: Deadline,
  signal?: AbortSignal,
): Promise<Response> {
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) {
    throw new AppError('COMMAND_FAILED', 'Runner command deadline exceeded', {
      port,
      timeoutMs: remainingMs,
    });
  }
  return await usbmuxRunnerTransport.postCommand(device.id, port, command, remainingMs, signal);
}

/**
 * A CoreDevice-backed device that usbmuxd does not list is reachable over its
 * network tunnel instead. XCTest-backed devices have no such tunnel, so their
 * usbmux verdict stands.
 */
export function canFallBackFromUsbmux(device: DeviceInfo, error: unknown): boolean {
  if (!isUsbmuxDeviceUnattachedError(error)) return false;
  return resolveIosPhysicalDeviceControl(device).backend !== 'xctest';
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  requestSignal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
  return await fetch(url, { ...init, signal });
}
