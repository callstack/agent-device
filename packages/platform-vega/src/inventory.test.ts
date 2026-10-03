import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type {
  DeviceInventoryHostFor,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import { createVegaInventory } from './inventory.ts';

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('Vega inventory resolves the default CLI lazily and accepts only its virtual device', async () => {
  const host = createHost({
    which: async () => undefined,
    isExecutable: async (path) => path === '/Users/test/vega/bin/vega',
    run: async (request) => {
      assert.equal(request.executable, '/Users/test/vega/bin/vega');
      assert.deepEqual(request.args, ['device', 'list']);
      assert.equal(request.timeoutMs, 10_000);
      return result('physical : tv\nVirtualDevice : tv - aarch64 - VegaOS\n');
    },
  });

  const devices = await createVegaInventory(host).discover({}, scope);

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

test('Vega inventory fails closed when only an unsupported physical target is present', async () => {
  const host = createHost({ run: async () => result('physical : tv\n') });
  await assert.rejects(
    createVegaInventory(host).discover({}, scope),
    (error: unknown) => error instanceof AppError && error.code === 'DEVICE_NOT_FOUND',
  );
});

function createHost(options: {
  which?: DeviceInventoryHostFor<'vega'>['commands']['which'];
  isExecutable?: DeviceInventoryHostFor<'vega'>['files']['isExecutable'];
  run: DeviceInventoryHostFor<'vega'>['commands']['run'];
}): DeviceInventoryHostFor<'vega'> {
  return {
    commands: { which: options.which ?? (async () => 'vega'), run: options.run },
    files: {
      isExecutable: options.isExecutable ?? (async () => false),
      createTemporaryTextFile: async () => {
        throw new Error('unused');
      },
    },
    homeDirectory: '/Users/test',
  };
}

function result(stdout: string, stderr = '', exitCode = 0) {
  return { stdout, stderr, exitCode };
}
