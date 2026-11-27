import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type {
  DeviceInventoryHostFor,
  HostCommandRequest,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import { createAndroidInventory } from './inventory.ts';

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

const PROPS_PROBE =
  'getprop sys.boot_completed; getprop ro.boot.qemu.avd_name; getprop persist.sys.avd_name; ' +
  'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.characteristics';

/** One line per property, in the props probe's order. */
function props(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

const RUNNING_EMULATOR_PROBES: ReadonlyArray<readonly [string, string]> = [
  [PROPS_PROBE, props(['1', 'Pixel_9_Pro_XL', '', 'sdk_gphone16k_arm64', '17', 'phone'])],
  ['pm\0list\0features', 'feature:android.hardware.wifi\n'],
];

const isShellProbe = (call: HostCommandRequest) => call.args.includes('shell');

test.each([
  ['include-stopped', true],
  ['running-only', false],
] as const)(
  'Android inventory %s policy owns stopped-AVD placeholder resolution',
  async (androidAvdSelection, includesStoppedAvd) => {
    const calls: HostCommandRequest[] = [];
    const host = createHost(async (request) => {
      calls.push(request);
      const key = request.args.join('\0');
      if (request.executable === 'emulator') return result('Pixel_9_Pro_XL\nLiving_Room_TV\n');
      if (key === 'devices\0-l') {
        return result(
          'List of devices attached\nemulator-5554 device model:Pixel_9_Pro_XL\nphysical-1 device model:Phone\n',
        );
      }
      const probe = RUNNING_EMULATOR_PROBES.find(([fragment]) => key.includes(fragment));
      if (probe) return result(probe[1]);
      throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
    });

    const devices = await createAndroidInventory(host).discover(
      { androidSerialAllowlist: ['emulator-5554'], androidAvdSelection },
      scope,
    );

    assert.deepEqual(
      devices.map((candidate) => [
        candidate.id,
        candidate.name,
        candidate.booted,
        candidate.model,
        candidate.osVersion,
      ]),
      [
        ['emulator-5554', 'Pixel 9 Pro XL', true, 'sdk_gphone16k_arm64', '17'],
        ...(includesStoppedAvd
          ? [['Living_Room_TV', 'Living_Room_TV', false, undefined, undefined] as const]
          : []),
      ],
    );
    // One getprop batch and one feature list per running device, and nothing else on its shell.
    assert.deepEqual(
      calls.filter(isShellProbe).map((call) => call.args),
      [
        ['-s', 'emulator-5554', 'shell', PROPS_PROBE],
        ['-s', 'emulator-5554', 'shell', 'pm', 'list', 'features'],
      ],
    );
    assert.ok(calls.every((call) => call.timeoutMs === 10_000));
    assert.ok(calls.every((call) => call.allowFailure === true));
  },
);

const EMULATOR_CRASHDATA_BANNER =
  'INFO    | Storing crashdata in: /tmp/user/emu-crash-34.2.16.db, detection is enabled for process: 98765';

test.each([
  ['only the crashdata banner', `${EMULATOR_CRASHDATA_BANNER}\n`, []],
  [
    'the crashdata banner beside AVD names',
    `${EMULATOR_CRASHDATA_BANNER}\r\nPixel_9_Pro_XL\r\nwear-os.36\r\n`,
    ['Pixel_9_Pro_XL', 'wear-os.36'],
  ],
] as const)(
  'Android inventory lists only AVD names when emulator -list-avds prints %s',
  async (_case, listAvdsStdout, expectedAvds) => {
    const host = createHost(async (request) => {
      if (request.executable === 'emulator') return result(listAvdsStdout);
      if (request.args.join('\0') === 'devices\0-l') return result('List of devices attached\n');
      throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
    });

    const devices = await createAndroidInventory(host).discover(
      { androidAvdSelection: 'include-stopped' },
      scope,
    );

    assert.deepEqual(
      devices.map((device) => device.id),
      expectedAvds,
    );
  },
);

test('Android inventory leaves model, OS version, and boot state unset when the props probe exits non-zero', async () => {
  const host = createHost(async (request) => {
    const key = request.args.join('\0');
    if (key === 'devices\0-l')
      return result('List of devices attached\nR5CT1 device model:SM_S921B\n');
    if (key.includes(PROPS_PROBE)) return result('', 'error: closed', 1);
    const probe = RUNNING_EMULATOR_PROBES.find(([fragment]) => key.includes(fragment));
    if (probe) return result(probe[1]);
    throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
  });

  const [device] = await createAndroidInventory(host).discover(
    { androidAvdSelection: 'running-only' },
    scope,
  );

  assert.deepEqual(
    [device?.name, device?.booted, device?.model, device?.osVersion, device?.target],
    ['SM S921B', false, undefined, undefined, 'mobile'],
  );
});

test('Android inventory keeps a device whose props probe times out listed with an unknown target', async () => {
  const diagnostics: unknown[] = [];
  const host = createHost(async (request) => {
    const key = request.args.join('\0');
    if (key === 'devices\0-l')
      return result('List of devices attached\nR5CT1 device model:SM_S921B\n');
    if (key.includes(PROPS_PROBE)) {
      throw new AppError('COMMAND_FAILED', 'adb timed out after 10000ms', { timeoutMs: 10_000 });
    }
    const probe = RUNNING_EMULATOR_PROBES.find(([fragment]) => key.includes(fragment));
    if (probe) return result(probe[1]);
    throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
  });

  const [device] = await createAndroidInventory(host).discover(
    { androidAvdSelection: 'running-only' },
    { ...scope, diagnostics: { emit: (event) => diagnostics.push(event) } },
  );

  assert.deepEqual(
    [device?.name, device?.booted, device?.model, device?.target],
    ['SM S921B', false, undefined, undefined],
  );
  assert.equal(diagnostics.length, 1);
});

test('Android inventory fails when the props probe fails for a reason other than a timeout', async () => {
  const host = createHost(async (request) => {
    const key = request.args.join('\0');
    if (key === 'devices\0-l')
      return result('List of devices attached\nR5CT1 device model:SM_S921B\n');
    if (key.includes(PROPS_PROBE)) throw new AppError('COMMAND_FAILED', 'spawn adb EACCES');
    const probe = RUNNING_EMULATOR_PROBES.find(([fragment]) => key.includes(fragment));
    if (probe) return result(probe[1]);
    throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
  });

  await assert.rejects(
    createAndroidInventory(host).discover({ androidAvdSelection: 'running-only' }, scope),
    (error: unknown) => error instanceof AppError && error.message === 'spawn adb EACCES',
  );
});

test.each([
  ['the props name it', props(['1', 'Pixel_9', '', 'sdk_gphone64_arm64', '16', 'emulator']), []],
  [
    'only persist.sys.avd_name names it',
    props(['1', '', 'Pixel_9', 'sdk_gphone64_arm64', '16', 'emulator']),
    [],
  ],
  [
    'no prop names it',
    props(['1', '', '', 'sdk_gphone64_arm64', '16', 'emulator']),
    [['-s', 'emulator-5560', 'emu', 'avd', 'name']],
  ],
] as const)(
  'Android inventory names an emulator from its AVD when %s',
  async (_case, propsOutput, consoleCalls) => {
    const calls: string[][] = [];
    const host = createHost(async (request) => {
      const key = request.args.join('\0');
      if (key === 'devices\0-l') return result('List of devices attached\nemulator-5560 device\n');
      if (key.includes(PROPS_PROBE)) return result(propsOutput);
      if (key.includes('emu\0avd\0name')) {
        calls.push([...request.args]);
        return result('Pixel_9\r\nOK\r\n');
      }
      const probe = RUNNING_EMULATOR_PROBES.find(([fragment]) => key.includes(fragment));
      if (probe) return result(probe[1]);
      throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
    });

    const [device] = await createAndroidInventory(host).discover(
      { androidAvdSelection: 'running-only' },
      scope,
    );

    assert.equal(device?.name, 'Pixel 9');
    assert.deepEqual(calls, consoleCalls);
  },
);

test.each([
  ['feature:android.software.leanback_only\nfeature:android.hardware.wifi\n', 'tv'],
  ['feature:android.hardware.type.television=1\n', 'tv'],
  ['feature:android.hardware.wifi\nfeature:amazon.hardware.fire_tv\n', 'tv'],
  ['feature:android.software.leanback_extra\nfeature:android.hardware.wifi\n', 'mobile'],
] as const)(
  'Android inventory reads the feature list %j as a %s target',
  async (featureList, target) => {
    const host = createHost(async (request) => {
      const key = request.args.join('\0');
      if (key === 'devices\0-l')
        return result('List of devices attached\nR5CT1 device model:Box\n');
      if (key.includes('pm\0list\0features')) return result(featureList);
      const probe = RUNNING_EMULATOR_PROBES.find(([fragment]) => key.includes(fragment));
      if (probe) return result(probe[1]);
      throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
    });

    const [device] = await createAndroidInventory(host).discover(
      { androidAvdSelection: 'running-only' },
      scope,
    );

    assert.equal(device?.target, target);
  },
);

test.each([
  ['a device the request does not select', undefined],
  ['the requested serial', 'AFTKMST12'],
] as const)(
  'Android inventory reads tv from ro.build.characteristics even when the feature list times out on %s',
  async (_case, serial) => {
    const host = createHost(async (request) => {
      const key = request.args.join('\0');
      if (key === 'devices\0-l') {
        return result('List of devices attached\nAFTKMST12 device model:AFTKMST12\n');
      }
      if (key.includes(PROPS_PROBE)) {
        return result(props(['1', '', '', 'AFTKMST12', '9', 'tv']));
      }
      if (key.includes('pm\0list\0features')) {
        throw new AppError('COMMAND_FAILED', 'adb timed out after 10000ms', { timeoutMs: 10_000 });
      }
      throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
    });

    const [device] = await createAndroidInventory(host).discover(
      { serial, androidAvdSelection: 'running-only' },
      scope,
    );

    assert.equal(device?.target, 'tv');
  },
);

test('Android inventory keeps a device whose feature probe times out from failing discovery of another', async () => {
  const diagnostics: unknown[] = [];
  const host = createHost(async (request) => {
    const key = request.args.join('\0');
    if (key === 'devices\0-l') {
      return result(
        'List of devices attached\nemulator-5554 device model:Busy\nemulator-5556 device model:Idle\n',
      );
    }
    if (key.includes('emulator-5554') && key.includes('pm\0list\0features')) {
      throw new AppError('COMMAND_FAILED', 'adb timed out after 10000ms', { timeoutMs: 10_000 });
    }
    const probe = RUNNING_EMULATOR_PROBES.find(([fragment]) => key.includes(fragment));
    if (probe) return result(probe[1]);
    throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
  });

  const devices = await createAndroidInventory(host).discover(
    { androidAvdSelection: 'running-only' },
    { ...scope, diagnostics: { emit: (event) => diagnostics.push(event) } },
  );

  // The stalled feature list takes only the busy device's target with it.
  assert.deepEqual(
    devices.map((device) => [device.id, device.target, device.booted, device.model]),
    [
      ['emulator-5554', undefined, true, 'sdk_gphone16k_arm64'],
      ['emulator-5556', 'mobile', true, 'sdk_gphone16k_arm64'],
    ],
  );
  assert.deepEqual(diagnostics, [
    {
      level: 'warn',
      phase: 'android_inventory_target_probe_failed',
      data: { serial: 'emulator-5554', adbFailure: 'timeout' },
    },
  ]);
});

test('Android inventory still aborts when the request is cancelled during the feature probe', async () => {
  const controller = new AbortController();
  const host = createHost(async (request) => {
    const key = request.args.join('\0');
    if (key === 'devices\0-l') return result('List of devices attached\nemulator-5554 device\n');
    if (key.includes('pm\0list\0features')) {
      controller.abort();
      throw new AppError('COMMAND_FAILED', 'aborted', { timeoutMs: 10_000 });
    }
    const probe = RUNNING_EMULATOR_PROBES.find(([fragment]) => key.includes(fragment));
    if (probe) return result(probe[1]);
    throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
  });

  await assert.rejects(
    createAndroidInventory(host).discover(
      { androidAvdSelection: 'running-only' },
      { ...scope, signal: controller.signal },
    ),
    (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
  );
});

test('Android inventory fails when the feature probe of the requested serial times out', async () => {
  const host = createHost(async (request) => {
    const key = request.args.join('\0');
    if (key === 'devices\0-l') return result('List of devices attached\nemulator-5554 device\n');
    if (key.includes('pm\0list\0features')) {
      throw new AppError('COMMAND_FAILED', 'adb timed out after 10000ms', { timeoutMs: 10_000 });
    }
    const probe = RUNNING_EMULATOR_PROBES.find(([fragment]) => key.includes(fragment));
    if (probe) return result(probe[1]);
    throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
  });

  await assert.rejects(
    createAndroidInventory(host).discover(
      { serial: 'emulator-5554', androidAvdSelection: 'running-only' },
      scope,
    ),
    (error: unknown) => error instanceof AppError && error.details?.adbFailure === 'timeout',
  );
});

test('Android inventory fails closed when adb is unavailable', async () => {
  const host = createHost(async () => result(''), { adb: undefined });
  await assert.rejects(
    createAndroidInventory(host).discover({}, scope),
    (error: unknown) => error instanceof AppError && error.code === 'TOOL_MISSING',
  );
});

test('Android inventory honors captured SDK roots and classifies adb transport failures', async () => {
  const calls: HostCommandRequest[] = [];
  const host = createHost(
    async (request) => {
      calls.push(request);
      return result('', 'error: device offline', 1);
    },
    { adb: undefined, emulator: undefined },
    async (candidate) => candidate === '/custom-sdk/platform-tools/adb',
  );

  await assert.rejects(
    createAndroidInventory(host, { sdkRoots: ['/custom-sdk'] }).discover({}, scope),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.details?.adbFailure === 'device_offline' &&
      error.details?.retriable === true,
  );
  assert.equal(calls[0]?.executable, '/custom-sdk/platform-tools/adb');
});

test('Android inventory prepares the legacy toolchain before an ANDROID_HOME-only discovery', async () => {
  const preparedFamilies: string[] = [];
  const host = {
    ...createHost(
      async (request) => {
        if (request.args.join('\0') === 'devices\0-l') return result('');
        if (request.executable.endsWith('/emulator')) return result('');
        throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
      },
      { adb: undefined, emulator: undefined },
      async (candidate) =>
        candidate === '/android-home/platform-tools/adb' ||
        candidate === '/android-home/emulator/emulator',
    ),
    toolchains: {
      prepare: async (family: string) => {
        preparedFamilies.push(family);
      },
    },
  };

  await createAndroidInventory(host, { sdkRoots: ['/android-home'] }).discover({}, scope);

  assert.deepEqual(preparedFamilies, ['android']);
});

test('Android inventory omits the home SDK root when the host names no home', async () => {
  // The rule: a host that names no home turns off only the home-derived default paths. Discovery
  // must still resolve adb from PATH and list devices, not fail the family (#3794 review).
  const probed: string[] = [];
  const host: DeviceInventoryHostFor<'android'> = {
    ...createHost(async () => result('List of devices attached\n')),
    homeDirectory: undefined,
    files: {
      isExecutable: async (candidate) => {
        probed.push(candidate);
        return false;
      },
      createTemporaryTextFile: async () => {
        throw new Error('unused');
      },
    },
  };

  await createAndroidInventory(host, { sdkRoots: ['/configured-sdk'] }).discover({}, scope);

  // The configured root is still probed; only the home-derived default root turns off. Without
  // the guard, path.join(undefined, 'Android', 'Sdk') throws before adb is ever resolved.
  assert.ok(probed.includes('/configured-sdk/platform-tools/adb'));
  assert.ok(probed.every((candidate) => !candidate.includes('Android')));
});

test('Android inventory classifies a killed adb probe as a timeout', async () => {
  // The exec layer kills a wedged adb with `timeoutMs` in details and no stderr, so discovery
  // must classify it rather than report an unclassified command failure.
  const host = createHost(async () => {
    throw new AppError('COMMAND_FAILED', 'adb timed out after 10000ms', { timeoutMs: 10_000 });
  });

  await assert.rejects(createAndroidInventory(host).discover({}, scope), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.adbFailure, 'timeout');
    assert.match(String(error.details?.hint), /wedged/);
    return true;
  });
});

function createHost(
  run: DeviceInventoryHostFor<'android'>['commands']['run'],
  tools: { adb?: string; emulator?: string } = { adb: 'adb', emulator: 'emulator' },
  isExecutable: DeviceInventoryHostFor<'android'>['files']['isExecutable'] = async () => false,
): DeviceInventoryHostFor<'android'> {
  return {
    commands: {
      which: async (executable) => tools[executable as keyof typeof tools],
      run,
    },
    toolchains: { prepare: async () => undefined },
    files: {
      isExecutable,
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
