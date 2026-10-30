import {
  createRequestCanceledError,
  discloseDispatch,
  AppError,
} from '@agent-device/kernel/errors';
import { Deadline, resolveIosPhysicalDeviceControl } from './host.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  createRunnerCommandRouteResolver,
  type RunnerCommandRoute,
} from './runner-command-route.ts';
import { isUsbmuxDeviceUnattachedError } from './runner-error-classification.ts';
import {
  type RunnerCommand,
  requireTokenEnforcingRunner,
  runnerRequestHeaders,
  type RunnerEndpoint,
} from './runner-contract.ts';
import { usbmuxRunnerTransport } from './runner-usbmux.ts';

export const RUNNER_COMMAND_TIMEOUT_MS = 45_000;

/** Sends one command; the reply is proven to come from a runner that enforces its token. */
export async function sendRunnerCommandOnce(
  device: DeviceInfo,
  endpoint: RunnerEndpoint,
  command: RunnerCommand,
  timeoutMs: number = RUNNER_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Response> {
  return requireTokenEnforcingRunner(
    await postRunnerCommandOnce(device, endpoint, command, timeoutMs, signal),
  );
}

async function postRunnerCommandOnce(
  device: DeviceInfo,
  endpoint: RunnerEndpoint,
  command: RunnerCommand,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  throwIfCanceledBeforeSend(signal);
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const resolver = createRunnerCommandRouteResolver(device, endpoint.port);
  let route = await resolver.resolveRoute(deadline.remainingMs());
  if (route.kind === 'usbmux') {
    try {
      return await postRunnerCommandOverRoute(device, route, {
        endpoint,
        command,
        timeoutMs: deadline.remainingMs(),
        signal,
      });
    } catch (error) {
      if (!canFallBackFromUsbmux(device, error)) throw error;
      resolver.markUsbmuxUnattached();
      route = await resolver.resolveRoute(deadline.remainingMs());
    }
  }
  return await postRunnerCommandOverRoute(device, route, {
    endpoint,
    command,
    timeoutMs: deadline.remainingMs(),
    signal,
  });
}

/**
 * Posts one command over a resolved route, the one write both the single send and the connect loop
 * make. A refusal before anything is written discloses `dispatched: no`.
 */
export async function postRunnerCommandOverRoute(
  device: DeviceInfo,
  route: RunnerCommandRoute,
  request: Readonly<{
    endpoint: RunnerEndpoint;
    command: RunnerCommand;
    timeoutMs: number;
    signal?: AbortSignal;
  }>,
): Promise<Response> {
  const { endpoint, command, timeoutMs, signal } = request;
  throwIfCanceledBeforeSend(signal);
  if (timeoutMs <= 0) {
    throw discloseDispatch(
      new AppError('COMMAND_FAILED', 'Runner command deadline exceeded', {
        port: endpoint.port,
        timeoutMs,
      }),
      'no',
    );
  }
  if (route.kind === 'usbmux') {
    return await usbmuxRunnerTransport.postCommand(device.id, endpoint, command, timeoutMs, signal);
  }
  if (!route.url) {
    throw discloseDispatch(
      new AppError('COMMAND_FAILED', 'Runner command endpoint not available', {
        port: endpoint.port,
      }),
      'no',
    );
  }
  return await fetchWithTimeout(
    route.url,
    {
      method: 'POST',
      headers: runnerRequestHeaders(endpoint),
      body: JSON.stringify(command),
    },
    timeoutMs,
    signal,
  );
}

/** A cancellation that lands before the POST is issued proves the runner received nothing. */
export function throwIfCanceledBeforeSend(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createRequestCanceledError({ dispatched: 'no' });
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
  try {
    // The token travels in a header, so a redirect must never carry it elsewhere.
    return await fetch(url, { ...init, redirect: 'error', signal });
  } catch (error) {
    // `AbortSignal.timeout` rejects with a bare DOMException that no recovery rule can
    // read. Only a rejection carrying that signal's own reason is our deadline: a
    // refused connection or a canceled request keeps the error it actually failed with.
    if (error === timeoutSignal.reason) {
      throw new AppError(
        'COMMAND_FAILED',
        'Runner command deadline exceeded',
        { timeoutMs },
        error,
      );
    }
    throw error;
  }
}
