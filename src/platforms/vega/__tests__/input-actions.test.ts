import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '../../../kernel/errors.ts';
import { pressVegaTvRemote } from '../input-actions.ts';
import { createLocalVegaToolProvider, withVegaToolProvider } from '../tool-provider.ts';

test('pressVegaTvRemote maps every shared button without leaking key names to callers', async () => {
  const commands: string[][] = [];
  const provider = createLocalVegaToolProvider({
    isAvailable: async () => true,
    run: async (args) => {
      commands.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await withVegaToolProvider(provider, async () => {
    for (const button of [
      'up',
      'down',
      'left',
      'right',
      'select',
      'menu',
      'home',
      'back',
    ] as const) {
      await pressVegaTvRemote({ id: 'VirtualDevice' }, button);
    }
  });

  assert.deepEqual(
    commands.map((args) => args.at(-1)),
    [
      'inputd-cli button_press KEY_UP',
      'inputd-cli button_press KEY_DOWN',
      'inputd-cli button_press KEY_LEFT',
      'inputd-cli button_press KEY_RIGHT',
      'inputd-cli button_press KEY_ENTER',
      'inputd-cli button_press KEY_MENU',
      'inputd-cli button_press KEY_HOMEPAGE',
      'inputd-cli button_press KEY_BACK',
    ],
  );
});

test('pressVegaTvRemote passes exact hold duration boundaries to inputd', async () => {
  const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  const provider = createLocalVegaToolProvider({
    isAvailable: async () => true,
    run: async (args, options) => {
      calls.push({ args, timeoutMs: options?.timeoutMs });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await withVegaToolProvider(provider, async () => {
    await pressVegaTvRemote({ id: 'VirtualDevice' }, 'select', 0);
    await pressVegaTvRemote({ id: 'VirtualDevice' }, 'select', 10_000);
  });

  assert.deepEqual(calls, [
    {
      args: [
        'device',
        'run-cmd',
        '--device',
        'VirtualDevice',
        '--command',
        'inputd-cli button_press KEY_ENTER --holdDuration 0',
      ],
      timeoutMs: 10_000,
    },
    {
      args: [
        'device',
        'run-cmd',
        '--device',
        'VirtualDevice',
        '--command',
        'inputd-cli button_press KEY_ENTER --holdDuration 10000',
      ],
      timeoutMs: 20_000,
    },
  ]);
});

test('pressVegaTvRemote surfaces unsupported inputd controls as command failures', async () => {
  const provider = createLocalVegaToolProvider({
    isAvailable: async () => true,
    run: async () => ({
      exitCode: 2,
      stdout: '',
      stderr: 'Unsupported key',
    }),
  });

  await assert.rejects(
    withVegaToolProvider(provider, async () => {
      await pressVegaTvRemote({ id: 'VirtualDevice' }, 'menu');
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.details?.button === 'menu' &&
      error.details?.processExitError === true,
  );
});
