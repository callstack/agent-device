import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { setAndroidSetting } from '../settings.ts';
import { assertRejectsAppError } from './test-utils/app-error.ts';
import { withFakeAdb, type FakeAdbResponse } from './test-utils/fake-adb.ts';
import { underFakeTimers } from './test-utils/fake-timers.ts';

const FEATURES = 'shell pm list features';
const SDK = 'shell getprop ro.build.version.sdk';
const STATE = 'shell settings get global bluetooth_on';
const ENABLE = 'shell svc bluetooth enable';
const WITH_ADAPTER = [
  'feature:android.hardware.bluetooth',
  'feature:android.hardware.bluetooth_le',
  'feature:android.hardware.wifi',
].join('\n');

type BluetoothManagerOptions = {
  write?: FakeAdbResponse;
  stateRead?: FakeAdbResponse;
  initialState?: string;
  stateAfterWrite?: (action: string) => string;
  staleReads?: number;
  honorWrites?: boolean;
};

/**
 * A Bluetooth manager that persists `bluetooth_on` after a write lands. `staleReads` is how many
 * reads still see the old value, `stateAfterWrite` what it persists, and `honorWrites: false` a
 * write the adapter refuses while the command still exits 0.
 */
function bluetoothManager(options: BluetoothManagerOptions) {
  let state = options.initialState ?? '0';
  let pending: string | undefined;
  let staleReads = 0;
  return {
    read(): FakeAdbResponse {
      if (options.stateRead) return options.stateRead;
      if (pending !== undefined && staleReads-- <= 0) {
        state = pending;
        pending = undefined;
      }
      return state;
    },
    write(action: string): FakeAdbResponse {
      if (options.honorWrites !== false) {
        pending = options.stateAfterWrite?.(action) ?? (action === 'enable' ? '1' : '0');
        staleReads = options.staleReads ?? 0;
      }
      return options.write ?? '';
    },
  };
}

function bluetoothDevice(
  sdk: FakeAdbResponse,
  options: BluetoothManagerOptions & { features?: FakeAdbResponse } = {},
) {
  const manager = bluetoothManager(options);
  const probes = new Map<string, FakeAdbResponse>([
    [FEATURES, options.features ?? WITH_ADAPTER],
    [SDK, sdk],
  ]);
  return (args: string[]): FakeAdbResponse => {
    const flat = args.join(' ');
    const probe = probes.get(flat);
    if (probe !== undefined) return probe;
    if (flat === STATE) return manager.read();
    const write = /^shell svc bluetooth (enable|disable)$/.exec(flat);
    if (write) return manager.write(write[1]!);
    return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
  };
}

test.each([
  { sdk: '27', state: 'on', write: ENABLE, bluetooth: 'enabled' },
  { sdk: '36', state: 'off', write: 'shell svc bluetooth disable', bluetooth: 'disabled' },
])(
  'setAndroidSetting bluetooth $state on API $sdk runs $write and reports $bluetooth',
  async ({ sdk, state, write, bluetooth }) => {
    const initialState = state === 'on' ? '0' : '1';
    await withFakeAdb(bluetoothDevice(sdk, { initialState }), async ({ calls, device }) => {
      assert.deepEqual(await setAndroidSetting(device, 'bluetooth', state), { bluetooth });
      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [FEATURES, SDK, write, STATE],
      );
    });
  },
);

test('setAndroidSetting bluetooth waits for the Bluetooth manager to persist the change', async () => {
  await withFakeAdb(bluetoothDevice('34', { staleReads: 2 }), async ({ calls, device }) => {
    const result = await underFakeTimers(() => setAndroidSetting(device, 'bluetooth', 'on'));
    assert.deepEqual(result, { bluetooth: 'enabled' });
    assert.deepEqual(
      calls.slice(3).map((args) => args.join(' ')),
      [STATE, STATE, STATE],
    );
  });
});

test('setAndroidSetting bluetooth off accepts the state airplane mode leaves behind', async () => {
  await withFakeAdb(
    bluetoothDevice('30', { initialState: '1', stateAfterWrite: () => '2' }),
    async ({ device }) => {
      assert.deepEqual(await setAndroidSetting(device, 'bluetooth', 'off'), {
        bluetooth: 'disabled',
      });
    },
  );
});

test.each([
  {
    name: 'a refused write',
    options: { honorWrites: false },
    message: /reads disabled after requesting enabled/,
    reason: 'bluetooth-not-applied',
    storedValue: '0',
  },
  {
    name: 'an unreadable state',
    options: { stateAfterWrite: () => 'null' },
    message: /unusable bluetooth_on value after requesting Bluetooth enabled: null/,
    reason: 'bluetooth-unreadable',
    storedValue: 'null',
  },
])(
  'setAndroidSetting bluetooth fails with $reason on $name that exits 0',
  async ({ options, message, reason, storedValue }) => {
    await withFakeAdb(bluetoothDevice('30', options), async ({ calls, device }) => {
      await expect(
        underFakeTimers(() => setAndroidSetting(device, 'bluetooth', 'on')),
      ).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        message: expect.stringMatching(message),
        details: {
          reason,
          storedValue,
          dispatched: 'unknown',
          hint: expect.stringMatching(/settings get global bluetooth_on/),
        },
      });
      assert.ok(calls.filter((args) => args.join(' ') === STATE).length > 1);
    });
  },
);

const offline = { stderr: 'error: device offline', exitCode: 1 };

test.each([
  {
    name: 'an unreadable feature list',
    device: bluetoothDevice('34', { features: offline }),
    error: {
      code: 'COMMAND_FAILED',
      message: /Failed to read Android device features/,
      details: { dispatched: 'no' },
    },
    calls: [FEATURES],
  },
  {
    // A Bluetooth LE feature alone is not the adapter feature the Bluetooth service needs.
    name: 'a device without an adapter',
    device: bluetoothDevice('34', { features: 'feature:android.hardware.bluetooth_le' }),
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: /no Bluetooth adapter/,
      details: {
        reason: 'android_bluetooth_adapter_missing',
        dispatched: 'no',
        hint: expect.stringMatching(/android\.hardware\.bluetooth/),
      },
    },
    calls: [FEATURES],
  },
  {
    name: 'an unreadable API level',
    device: bluetoothDevice({ stderr: 'getprop: closed', exitCode: 1 }),
    error: {
      code: 'COMMAND_FAILED',
      message: /Failed to read the Android API level/,
      details: { stderr: 'getprop: closed', exitCode: 1, dispatched: 'no' },
    },
    calls: [FEATURES, SDK],
  },
  {
    name: 'a build older than Android 8.1',
    device: bluetoothDevice('26'),
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: /no shell command for Bluetooth/,
      details: {
        reason: 'android_bluetooth_command_unavailable',
        dispatched: 'no',
        hint: expect.stringMatching(/Android 8\.1 \(API 27\)/),
      },
    },
    calls: [FEATURES, SDK],
  },
  {
    name: 'a failed write',
    device: bluetoothDevice('34', { write: { stderr: 'svc: closed', exitCode: 255 } }),
    error: {
      code: 'COMMAND_FAILED',
      message: /Failed to turn Android Bluetooth on/,
      details: { dispatched: 'unknown' },
    },
    calls: [FEATURES, SDK, ENABLE],
  },
  {
    name: 'a failed state read',
    device: bluetoothDevice('34', { stateRead: offline }),
    error: {
      code: 'COMMAND_FAILED',
      message: /Failed to read Android Bluetooth state/,
      details: { dispatched: 'unknown' },
    },
    calls: [FEATURES, SDK, ENABLE, STATE],
  },
])('setAndroidSetting bluetooth on stops at $name', async ({ device, error, calls }) => {
  await withFakeAdb(device, async ({ calls: made, device: target }) => {
    await expect(setAndroidSetting(target, 'bluetooth', 'on')).rejects.toMatchObject({
      ...error,
      message: expect.stringMatching(error.message),
    });
    assert.deepEqual(
      made.map((args) => args.join(' ')),
      calls,
    );
  });
});

test('setAndroidSetting bluetooth writes nothing once the request is cancelled during the checks', async () => {
  const controller = new AbortController();
  const script = bluetoothDevice('34');
  await withFakeAdb(
    (args) => {
      if (args.join(' ') === SDK) controller.abort();
      return script(args);
    },
    async ({ calls, device }) => {
      await assertRejectsAppError(
        () => setAndroidSetting(device, 'bluetooth', 'on', undefined, undefined, controller.signal),
        { code: 'COMMAND_FAILED', dispatched: 'no' },
      );
      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [FEATURES, SDK],
      );
    },
  );
});
