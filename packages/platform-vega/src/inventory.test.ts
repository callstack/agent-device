import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { createVegaHostStub } from './command-host.fixtures.ts';
import { createVegaInventory } from './inventory.ts';

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('Vega inventory resolves the CLI through its host and accepts only its virtual device', async () => {
  const stub = createVegaHostStub({
    env: { PATH: '/usr/bin', HOME: '/host-home' },
    onPath: [],
    executableFiles: ['/host-home/vega/bin/vega'],
  });
  stub.answer({ stdout: 'physical : tv\nVirtualDevice : tv - aarch64 - VegaOS\n' });

  const devices = await createVegaInventory(stub.toolbox.commands).discover({}, scope);

  assert.deepEqual(stub.commands[0]?.executable, '/host-home/vega/bin/vega');
  assert.deepEqual(stub.commands[0]?.args, ['device', 'list']);
  assert.equal(stub.commands[0]?.timeoutMs, 10_000);
  // Spelled out rather than compared against `parseVegaDeviceList(...)`: using the parser as the
  // expected value lets both sides move together, which is exactly how a dropped `physical` row or
  // a wrong `kind`/`booted` mapping would stay invisible.
  assert.deepEqual(devices, [
    {
      platform: 'vega',
      id: 'VirtualDevice',
      name: 'Vega Virtual Device (VirtualDevice)',
      kind: 'emulator',
      target: 'tv',
      booted: true,
    },
  ]);
});

test('Vega inventory prefers the CLI the host PATH resolves', async () => {
  const stub = createVegaHostStub({
    onPath: ['vega'],
    stdout: 'VirtualDevice : tv - aarch64 - VegaOS\n',
  });

  await createVegaInventory(stub.toolbox.commands).discover({}, scope);

  assert.equal(stub.commands[0]?.executable, 'vega');
});

test('Vega inventory reports a missing CLI before it spawns anything', async () => {
  const stub = createVegaHostStub({ onPath: [], executableFiles: [] });

  await assert.rejects(
    createVegaInventory(stub.toolbox.commands).discover({}, scope),
    (error: unknown) => error instanceof AppError && error.code === 'TOOL_MISSING',
  );
  assert.deepEqual(stub.commands, []);
});

test('Vega inventory fails closed when only an unsupported physical target is present', async () => {
  const stub = createVegaHostStub({ stdout: 'physical : tv\n' });
  await assert.rejects(
    createVegaInventory(stub.toolbox.commands).discover({}, scope),
    (error: unknown) => error instanceof AppError && error.code === 'DEVICE_NOT_FOUND',
  );
});

test('Vega inventory reports a failing CLI as a command failure carrying its stderr', async () => {
  const stub = createVegaHostStub({
    respond: () => ({ exitCode: 3, stderr: 'daemon unreachable' }),
  });
  await assert.rejects(
    createVegaInventory(stub.toolbox.commands).discover({}, scope),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.details?.processExitError === true &&
      error.details?.stderr === 'daemon unreachable',
  );
});
