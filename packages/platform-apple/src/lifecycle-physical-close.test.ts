import { expect, test, vi } from 'vitest';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { AppError } from '@agent-device/kernel/errors';

import { bindAppleApplicationLifecycle } from './lifecycle.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import { device } from './lifecycle.fixtures.ts';

test('close stops a physical Apple runner before the platform close and skips the close when the stop fails', async () => {
  const signal = new AbortController().signal;
  const events: string[] = [];
  const preCloseError = new AppError('RUNNER_UNAVAILABLE', 'runner stop failed', {
    reason: 'runner_stop_failed',
  });
  const interactor = {
    close: vi.fn(async () => {
      events.push('close');
    }),
  } as unknown as Interactor;
  const baseHost = platformRuntimeHostFixture();
  const stopRunnerSession = vi.fn(async () => {
    events.push('stop');
    throw preCloseError;
  });
  const host = {
    ...baseHost,
    localInteractors: { resolve: async () => interactor },
    appleApplications: { ...baseHost.appleApplications, stopRunnerSession },
  } as unknown as PlatformRuntimeHost;
  const lifecycle = bindAppleApplicationLifecycle({ host, device, signal });

  await expect(
    lifecycle.closeApplication({
      positionals: ['com.example.app'],
      surface: 'app',
      execution: {},
    }),
  ).rejects.toBe(preCloseError);

  expect(events).toEqual(['stop']);
  expect(stopRunnerSession).toHaveBeenCalledWith(device.id);
  expect(interactor.close).not.toHaveBeenCalled();
});

test('close --shutdown is ignored for a physical Apple device', async () => {
  const signal = new AbortController().signal;
  const baseHost = platformRuntimeHostFixture();
  const shutdownTarget = vi.fn(async () => ({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  }));
  const host = {
    ...baseHost,
    deviceShutdown: { ...baseHost.deviceShutdown, apple: { shutdownTarget } },
  } as unknown as PlatformRuntimeHost;
  const lifecycle = bindAppleApplicationLifecycle({ host, device, signal });

  const result = await lifecycle.finalizeApplicationClose({
    surface: 'app',
    retainRunner: false,
    stateDir: '/tmp',
    shutdownTarget: true,
  });

  expect(shutdownTarget).not.toHaveBeenCalled();
  expect(result).toEqual({});
});
