import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { pressVegaTvRemote } from '../input-actions.ts';
import { createVegaCommandRunnerStub } from '../command-host.fixtures.ts';
import { createVegaToolProvider, withVegaToolProvider } from '../tool-provider.ts';

test('pressVegaTvRemote maps every shared button without leaking key names to callers', async () => {
  const commands = createVegaCommandRunnerStub();

  await withVegaToolProvider(createVegaToolProvider(commands), async () => {
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
    commands.calls.map(({ args }) => args.at(-1)),
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
  const commands = createVegaCommandRunnerStub();

  await withVegaToolProvider(createVegaToolProvider(commands), async () => {
    await pressVegaTvRemote({ id: 'VirtualDevice' }, 'select', 0);
    await pressVegaTvRemote({ id: 'VirtualDevice' }, 'select', 10_000);
  });

  assert.deepEqual(commands.calls, [
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
      allowFailure: true,
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
      allowFailure: true,
    },
  ]);
});

test('pressVegaTvRemote surfaces unsupported inputd controls as command failures', async () => {
  const commands = createVegaCommandRunnerStub([
    { exitCode: 2, stdout: '', stderr: 'Unsupported key' },
  ]);

  await assert.rejects(
    withVegaToolProvider(createVegaToolProvider(commands), async () => {
      await pressVegaTvRemote({ id: 'VirtualDevice' }, 'menu');
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.details?.button === 'menu' &&
      error.details?.processExitError === true,
  );
});
