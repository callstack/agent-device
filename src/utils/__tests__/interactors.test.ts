import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { RunnerCommand } from '../../platforms/ios/runner-client.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';

vi.mock('../../platforms/ios/runner-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/ios/runner-client.ts')>();
  return { ...actual, runIosRunnerCommand: vi.fn() };
});

import { getInteractor } from '../../core/interactors.ts';
import { resolveAppleBackRunnerCommand } from '../../platforms/ios/interactions.ts';
import { runIosRunnerCommand } from '../../platforms/ios/runner-client.ts';

const iosSimulator: DeviceInfo = {
  platform: 'ios',
  id: 'sim-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

const tvOsSimulator: DeviceInfo = {
  platform: 'ios',
  id: 'tv-sim-1',
  name: 'Apple TV',
  kind: 'simulator',
  target: 'tv',
  booted: true,
};

const mockRunIosRunnerCommand = vi.mocked(runIosRunnerCommand);

beforeEach(() => {
  vi.restoreAllMocks();
  mockRunIosRunnerCommand.mockReset();
});

test('resolveAppleBackRunnerCommand defaults plain back to in-app navigation', () => {
  assert.equal(resolveAppleBackRunnerCommand(), 'backInApp');
});

test('resolveAppleBackRunnerCommand maps explicit back modes to runner commands', () => {
  assert.equal(resolveAppleBackRunnerCommand('in-app'), 'backInApp');
  assert.equal(resolveAppleBackRunnerCommand('system'), 'backSystem');
});

test('ios scroll sends a single fused scroll command and reports planned pixels', async () => {
  const commands: RunnerCommand[] = [];
  mockRunIosRunnerCommand.mockImplementation(async (_device, command) => {
    commands.push(command);
    if (command.command === 'scroll') {
      // x2/y2 endpoint travel is 119 here; planned pixels (120) must be preferred.
      return {
        x: 155,
        y: 420,
        x2: 155,
        y2: 301,
        referenceWidth: 300,
        referenceHeight: 600,
        gestureStartUptimeMs: 1,
        gestureEndUptimeMs: 2,
      };
    }
    throw new Error(`Unexpected runner command: ${command.command}`);
  });
  const interactor = await getInteractor(iosSimulator, { appBundleId: 'com.example.app' });
  const result = await interactor.scroll('down', { pixels: 120 });

  // The common iOS scroll path issues exactly one lifecycle command and NO 'interactionFrame'.
  assert.deepEqual(commands, [
    { command: 'scroll', direction: 'down', pixels: 120, appBundleId: 'com.example.app' },
  ]);
  assert.deepEqual(result, {
    x1: 155,
    y1: 420,
    x2: 155,
    y2: 301,
    referenceWidth: 300,
    referenceHeight: 600,
    pixels: 120,
  });
});

test('ios amount-based scroll recomputes pixels from the runner reference frame', async () => {
  const commands: RunnerCommand[] = [];
  mockRunIosRunnerCommand.mockImplementation(async (_device, command) => {
    commands.push(command);
    if (command.command === 'scroll') {
      return {
        x: 150,
        y: 450,
        x2: 150,
        y2: 150,
        referenceWidth: 300,
        referenceHeight: 600,
      };
    }
    throw new Error(`Unexpected runner command: ${command.command}`);
  });
  const interactor = await getInteractor(iosSimulator, { appBundleId: 'com.example.app' });
  const result = await interactor.scroll('down', { amount: 0.5 });

  assert.deepEqual(commands, [
    { command: 'scroll', direction: 'down', amount: 0.5, appBundleId: 'com.example.app' },
  ]);
  // amount 0.5 against a 600px vertical axis -> 300 planned pixels.
  const amount =
    result && typeof result === 'object' && 'amount' in result ? result.amount : undefined;
  const pixels =
    result && typeof result === 'object' && 'pixels' in result ? result.pixels : undefined;
  assert.equal(amount, 0.5);
  assert.equal(pixels, 300);
});

test('tvOS scroll sends only a remotePress command (behavior unchanged)', async () => {
  const commands: RunnerCommand[] = [];
  mockRunIosRunnerCommand.mockImplementation(async (_device, command) => {
    commands.push(command);
    return {};
  });
  const interactor = await getInteractor(tvOsSimulator, { appBundleId: 'com.example.app' });

  await interactor.scroll('down');

  assert.deepEqual(commands, [
    { command: 'remotePress', remoteButton: 'down', appBundleId: 'com.example.app' },
  ]);
});

test('ios scroll rejects non-positive amount before sending any runner command', async () => {
  mockRunIosRunnerCommand.mockImplementation(async () => ({}));
  const interactor = await getInteractor(iosSimulator, { appBundleId: 'com.example.app' });

  await assert.rejects(
    () => interactor.scroll('down', { amount: 0 }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /amount must be a positive number/i.test(error.message),
  );
  assert.equal(mockRunIosRunnerCommand.mock.calls.length, 0);
});

test('ios scroll without reference dims derives pixels from endpoint travel', async () => {
  mockRunIosRunnerCommand.mockImplementation(async (_device, command) => {
    if (command.command === 'scroll') {
      return { x: 150, y: 450, x2: 150, y2: 150 };
    }
    throw new Error(`Unexpected runner command: ${command.command}`);
  });
  const interactor = await getInteractor(iosSimulator, { appBundleId: 'com.example.app' });
  const result = await interactor.scroll('down', { pixels: 120 });

  const pixels =
    result && typeof result === 'object' && 'pixels' in result ? result.pixels : undefined;
  // No referenceWidth/Height in the response -> pixels fall back to |y2 - y1| = 300.
  assert.equal(pixels, 300);
});

test('ios fill sends one verified replacement text-entry command at the target coordinates', async () => {
  const commands: RunnerCommand[] = [];
  mockRunIosRunnerCommand.mockImplementation(async (_device, command) => {
    commands.push(command);
    return {};
  });
  const interactor = await getInteractor(iosSimulator, { appBundleId: 'com.example.app' });

  await interactor.fill(120, 240, 'hunter2');

  assert.deepEqual(commands, [
    {
      command: 'type',
      x: 120,
      y: 240,
      text: 'hunter2',
      textEntryMode: 'replace',
      delayMs: undefined,
      appBundleId: 'com.example.app',
    },
  ]);
});

test('ios type uses verified append text-entry mode', async () => {
  const commands: RunnerCommand[] = [];
  mockRunIosRunnerCommand.mockImplementation(async (_device, command) => {
    commands.push(command);
    return {};
  });
  const interactor = await getInteractor(iosSimulator, { appBundleId: 'com.example.app' });

  await interactor.type('hello', 25);

  assert.deepEqual(commands, [
    {
      command: 'type',
      text: 'hello',
      delayMs: 25,
      textEntryMode: 'append',
      appBundleId: 'com.example.app',
    },
  ]);
});
