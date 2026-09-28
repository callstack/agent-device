import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { pairAppleWearable } from './wearable-pairing.ts';

const phone: DeviceInfo = {
  platform: 'apple',
  id: 'phone-1',
  name: 'iPhone 16',
  kind: 'simulator',
  target: 'mobile',
  appleOs: 'ios',
  booted: true,
};

const watchInventory = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
      { name: 'Apple Watch Series 10', udid: 'watch-1', state: 'Booted', isAvailable: true },
    ],
  },
});

test('pairs and activates a selected watchOS simulator', async () => {
  const calls: string[][] = [];
  let pairListCount = 0;
  const run = vi.fn(async ({ args }: { args: readonly string[] }) => {
    const argv = [...args];
    calls.push(argv);
    if (argv.includes('devices')) return result(watchInventory);
    if (argv.includes('pairs')) {
      pairListCount += 1;
      if (pairListCount === 1) return result(JSON.stringify({ pairs: {} }));
      return result(
        JSON.stringify({
          pairs: {
            'pair-1': {
              phone: { udid: phone.id },
              watch: { udid: 'watch-1' },
              state: pairListCount > 2 ? 'active, connected' : 'paired',
            },
          },
        }),
      );
    }
    if (argv.includes('pair')) return result('pair-1');
    return result('');
  });

  const paired = await pairAppleWearable(host(run), phone, { boot: false }, signal());

  expect(paired).toMatchObject({ pairId: 'pair-1', status: 'connected' });
  expect(paired.wearable).toMatchObject({ id: 'watch-1', appleOs: 'watchos' });
  expect(calls).toContainEqual(['pair', phone.id, 'watch-1']);
  expect(calls.some((args) => args.includes('pair_activate'))).toBe(true);
});

test('rolls back only a pair created by the failed request', async () => {
  const calls: string[][] = [];
  const run = vi.fn(async ({ args }: { args: readonly string[] }) => {
    const argv = [...args];
    calls.push(argv);
    if (argv.includes('devices')) return result(watchInventory);
    if (argv.includes('pairs')) {
      return calls.filter((entry) => entry.includes('pairs')).length === 1
        ? result(JSON.stringify({ pairs: {} }))
        : result(
            JSON.stringify({
              pairs: {
                'pair-1': {
                  phone: { udid: phone.id },
                  watch: { udid: 'watch-1' },
                  state: 'paired',
                },
              },
            }),
          );
    }
    if (argv.includes('pair_activate')) return result('', 1, 'activation failed');
    if (argv.includes('pair')) return result('pair-1');
    return result('');
  });

  await expect(
    pairAppleWearable(host(run), phone, { boot: false }, signal()),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
  });
  expect(calls.some((args) => args.includes('unpair') && args.includes('pair-1'))).toBe(true);
});

test('boots a stopped watch, pairs it, and rolls back only request-owned resources on failure', async () => {
  const calls: string[][] = [];
  let pairListCount = 0;
  const stoppedInventory = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
        { name: 'Apple Watch Series 10', udid: 'watch-1', state: 'Shutdown', isAvailable: true },
      ],
    },
  });
  const run = vi.fn(async ({ args }: { args: readonly string[] }) => {
    const argv = [...args];
    calls.push(argv);
    if (argv.includes('devices')) return result(stoppedInventory);
    if (argv.includes('pairs')) {
      pairListCount += 1;
      const pairs: Record<string, unknown> = {
        'existing-pair': {
          phone: { udid: 'other-phone' },
          watch: { udid: 'other-watch' },
          state: 'active, connected',
        },
      };
      if (pairListCount > 1) {
        pairs['pair-1'] = {
          phone: { udid: phone.id },
          watch: { udid: 'watch-1' },
          state: 'paired',
        };
      }
      return result(JSON.stringify({ pairs }));
    }
    if (argv.includes('pair_activate')) return result('', 1, 'activation failed');
    if (argv.includes('pair')) return result('pair-1');
    return result('');
  });

  await expect(
    pairAppleWearable(
      host(run),
      phone,
      { wearable: { deviceId: 'watch-1' }, boot: true },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });

  const bootIndex = calls.findIndex((args) => args.includes('boot') && args.includes('watch-1'));
  const bootStatusIndex = calls.findIndex((args) => args.includes('bootstatus'));
  const pairIndex = calls.findIndex((args) => args.includes('pair') && args.includes('watch-1'));
  expect(bootIndex).toBeGreaterThanOrEqual(0);
  expect(bootStatusIndex).toBeGreaterThan(bootIndex);
  expect(pairIndex).toBeGreaterThan(bootStatusIndex);
  expect(calls.filter((args) => args.includes('unpair'))).toHaveLength(1);
  expect(calls.find((args) => args.includes('unpair'))).toContain('pair-1');
  expect(calls.find((args) => args.includes('unpair'))).not.toContain('existing-pair');
  expect(calls.some((args) => args.includes('shutdown') && args.includes('watch-1'))).toBe(true);
});

test('does not treat inactive or disconnected pair states as active', async () => {
  const calls: string[][] = [];
  const run = vi.fn(async ({ args }: { args: readonly string[] }) => {
    const argv = [...args];
    calls.push(argv);
    if (argv.includes('devices')) return result(watchInventory);
    if (argv.includes('pairs'))
      return result(
        JSON.stringify({
          pairs: {
            'pair-1': {
              phone: { udid: phone.id },
              watch: { udid: 'watch-1' },
              state: 'inactive, disconnected',
            },
          },
        }),
      );
    return result('');
  });

  await pairAppleWearable(host(run), phone, { boot: false }, signal());
  expect(calls.some((args) => args.includes('pair_activate'))).toBe(true);
});

function host(run: ReturnType<typeof vi.fn>): PlatformRuntimeHost {
  return { appleTools: { run } } as unknown as PlatformRuntimeHost;
}

function result(stdout: string, exitCode = 0, stderr = '') {
  return { stdout, stderr, exitCode };
}

function signal() {
  return new AbortController().signal;
}
