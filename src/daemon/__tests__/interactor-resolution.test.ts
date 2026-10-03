import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { installInteractorResolution, interactorResolution } from '../interactor-resolution.ts';

const device = { id: 'device-1', name: 'iPhone 16' } as unknown as DeviceInfo;
const runnerContext: RunnerContext = {};

let previous = interactorResolution();

beforeEach(() => {
  previous = interactorResolution();
});

afterEach(() => {
  installInteractorResolution(previous);
});

test('an un-composed process fails closed instead of reaching for a lookup of its own', async () => {
  const failure = await interactorResolution()
    .resolve(device, runnerContext)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AppError);
  expect((failure as AppError).details?.reason).toBe('interactor-resolution-missing');
});

test('the installed resolution is what the daemon resolves through', async () => {
  const interactor = { snapshot: async () => ({ nodes: [] }) } as unknown as Interactor;
  const resolve = vi.fn(async () => interactor);
  installInteractorResolution({ resolve });

  await expect(interactorResolution().resolve(device, runnerContext)).resolves.toBe(interactor);
  expect(resolve).toHaveBeenCalledWith(device, runnerContext);
});
