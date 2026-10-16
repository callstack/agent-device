import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { SETTINGS_APP_NOT_PACKAGE_REASON } from '@agent-device/contracts/settings';
import { TEXT_SIZE_CATEGORIES } from '@agent-device/contracts/settings-catalog';
import { AppError, PRE_DISPATCH_REFUSAL_REASONS } from '@agent-device/kernel/errors';
import { readAndroidSetting, setAndroidSetting } from '../settings.ts';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import { assertRejectsAppError } from './test-utils/app-error.ts';
import { withFakeAdb, type FakeAdbScript } from './test-utils/fake-adb.ts';

// The fake adb provider installs through the production withAndroidAdbProvider
// scope, so `calls` records device-scoped args without a leading `-s <serial>`.

test('setAndroidSetting appearance toggle flips current mode', async () => {
  await withFakeAdb(
    (args) => (args.join(' ') === 'shell cmd uimode night' ? 'Night mode: yes' : undefined),
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'appearance', 'toggle');
      assert.deepEqual(calls, [
        ['shell', 'cmd', 'uimode', 'night'],
        ['shell', 'cmd', 'uimode', 'night', 'no'],
      ]);
    },
  );
});

test('setAndroidSetting appearance toggle from auto sets dark mode', async () => {
  await withFakeAdb(
    (args) => (args.join(' ') === 'shell cmd uimode night' ? 'Night mode: auto' : undefined),
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'appearance', 'toggle');
      assert.deepEqual(calls[1], ['shell', 'cmd', 'uimode', 'night', 'yes']);
    },
  );
});

test('setAndroidSetting appearance toggle rejects unknown current mode output', async () => {
  await withFakeAdb(
    (args) => (args.join(' ') === 'shell cmd uimode night' ? 'mode unavailable' : undefined),
    async ({ device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'appearance', 'toggle'), {
        code: 'COMMAND_FAILED',
        message: /Unable to determine current Android appearance/,
      });
    },
  );
});

test('setAndroidSetting clear-app-state force stops and clears package data', async () => {
  await withFakeAdb(
    (args) => {
      const flat = args.join(' ');
      if (flat === 'shell pm list packages') return 'package:com.example.app\n';
      if (flat === 'shell am force-stop com.example.app') return '';
      if (flat === 'shell pm clear com.example.app') return 'Success';
      return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      const result = await setAndroidSetting(device, 'clear-app-state', 'clear', 'com.example.app');
      assert.deepEqual(result, { package: 'com.example.app', cleared: true });
      assert.deepEqual(calls, [
        ['shell', 'pm', 'list', 'packages'],
        ['shell', 'am', 'force-stop', 'com.example.app'],
        ['shell', 'pm', 'clear', 'com.example.app'],
      ]);
    },
  );
});

test('setAndroidSetting clear-app-state refuses an appless session with the published reason', async () => {
  await withFakeAdb(
    (args) => ({ stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 }),
    async ({ device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'clear-app-state', 'clear'), {
        code: 'INVALID_ARGS',
        reason: PRE_DISPATCH_REFUSAL_REASONS.sessionAppRequired,
        dispatched: 'no',
      });
    },
  );
});

const INSTALLED_PACKAGES = 'package:com.example.app\npackage:com.android.chrome\n';

const LIST_PACKAGES = ['shell', 'pm', 'list', 'packages'];
const CURRENT_USER = ['shell', 'am', 'get-current-user'];

function installedPackagesAdb(args: string[]) {
  const flat = args.join(' ');
  if (flat === 'shell pm list packages' || flat === 'shell pm list packages --user 0') {
    return INSTALLED_PACKAGES;
  }
  if (flat === 'shell am get-current-user') return '0';
  if (flat.startsWith('shell dumpsys package ') || flat.startsWith('shell pm grant ')) return '';
  return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
}

test('setAndroidSetting permission grants the package a display name resolves to', async () => {
  await withFakeAdb(installedPackagesAdb, async ({ calls, device }) => {
    await setAndroidSetting(device, 'permission', 'grant', 'Chrome', {
      permissionTarget: 'camera',
    });
    assert.deepEqual(calls, [
      CURRENT_USER,
      [...LIST_PACKAGES, '--user', '0'],
      ['shell', 'dumpsys', 'package', 'com.android.chrome'],
      ['shell', 'pm', 'grant', '--user', '0', 'com.android.chrome', 'android.permission.CAMERA'],
    ]);
  });
});

test('setAndroidSetting permission grants an installed package as named', async () => {
  await withFakeAdb(installedPackagesAdb, async ({ calls, device }) => {
    await setAndroidSetting(device, 'permission', 'grant', 'com.example.app', {
      permissionTarget: 'camera',
    });
    assert.deepEqual(calls.at(-1), [
      'shell',
      'pm',
      'grant',
      '--user',
      '0',
      'com.example.app',
      'android.permission.CAMERA',
    ]);
  });
});

test('setAndroidSetting permission checks the packages of the user it grants for', async () => {
  await withFakeAdb(
    (args) => {
      const flat = args.join(' ');
      if (flat === 'shell am get-current-user') return '10';
      if (flat === 'shell pm list packages --user 10') return 'package:com.example.secondary\n';
      if (flat.startsWith('shell dumpsys package ') || flat.startsWith('shell pm grant '))
        return '';
      return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'permission', 'grant', 'com.example.secondary', {
        permissionTarget: 'camera',
      });
      assert.deepEqual(calls, [
        CURRENT_USER,
        [...LIST_PACKAGES, '--user', '10'],
        ['shell', 'dumpsys', 'package', 'com.example.secondary'],
        // prettier-ignore
        ['shell', 'pm', 'grant', '--user', '10', 'com.example.secondary', 'android.permission.CAMERA'],
      ]);
    },
  );
});

test('setAndroidSetting permission refuses a name resolved earlier whose package is gone', async () => {
  let packages = INSTALLED_PACKAGES;
  await withFakeAdb(
    (args) =>
      args.join(' ') === 'shell pm list packages --user 0' ? packages : installedPackagesAdb(args),
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'permission', 'grant', 'Chrome', {
        permissionTarget: 'camera',
      });
      packages = 'package:com.example.app\n';
      calls.length = 0;
      await assertRejectsAppError(
        () =>
          setAndroidSetting(device, 'permission', 'grant', 'Chrome', {
            permissionTarget: 'camera',
          }),
        { code: 'APP_NOT_INSTALLED', reason: PRE_DISPATCH_REFUSAL_REASONS.appNotInstalled },
      );
      assert.deepEqual(calls, [CURRENT_USER, [...LIST_PACKAGES, '--user', '0']]);
    },
  );
});

test('setAndroidSetting permission requires an app in session with the published reason', async () => {
  await withFakeAdb(installedPackagesAdb, async ({ calls, device }) => {
    await assertRejectsAppError(
      () =>
        setAndroidSetting(device, 'permission', 'deny', undefined, { permissionTarget: 'camera' }),
      {
        code: 'INVALID_ARGS',
        reason: PRE_DISPATCH_REFUSAL_REASONS.sessionAppRequired,
        dispatched: 'no',
      },
    );
    assert.deepEqual(calls, []);
  });
});

test.for([
  ['permission', 'Nowhere'],
  ['clear-app-state', 'Nowhere'],
  ['permission', 'com.example.missing'],
  ['permission', 'com.example'],
] as const)(
  'setAndroidSetting %s refuses %s, which is no installed package, before changing anything',
  async ([setting, app]) => {
    await withFakeAdb(installedPackagesAdb, async ({ calls, device }) => {
      await assertRejectsAppError(
        () =>
          setAndroidSetting(device, setting, setting === 'permission' ? 'grant' : 'clear', app, {
            permissionTarget: 'camera',
          }),
        {
          code: 'APP_NOT_INSTALLED',
          reason: PRE_DISPATCH_REFUSAL_REASONS.appNotInstalled,
          dispatched: 'no',
          hint: /apps --all/,
        },
      );
      assert.deepEqual(
        calls,
        setting === 'permission'
          ? [CURRENT_USER, [...LIST_PACKAGES, '--user', '0']]
          : [LIST_PACKAGES],
      );
    });
  },
);

test('setAndroidSetting permission refuses an app alias that resolves to an intent', async () => {
  await withFakeAdb(installedPackagesAdb, async ({ calls, device }) => {
    await assertRejectsAppError(
      () =>
        setAndroidSetting(device, 'permission', 'grant', 'settings', {
          permissionTarget: 'camera',
        }),
      { code: 'INVALID_ARGS', reason: SETTINGS_APP_NOT_PACKAGE_REASON, dispatched: 'no' },
    );
    assert.deepEqual(calls, [CURRENT_USER]);
  });
});

test('setAndroidSetting permission validates the request before resolving the app', async () => {
  await withFakeAdb(installedPackagesAdb, async ({ calls, device }) => {
    await assertRejectsAppError(
      () =>
        setAndroidSetting(device, 'permission', 'grant', 'Nowhere', {
          permissionTarget: 'siri',
        }),
      { code: 'INVALID_ARGS' },
    );
    assert.deepEqual(calls, []);
  });
});

test('setAndroidSetting fingerprint retries emulator command when shell cmd fingerprint fails', async () => {
  await withFakeAdb(
    (args) => {
      if (args[0] === 'shell' && args[1] === 'cmd' && args[2] === 'fingerprint') {
        return { stderr: 'fingerprint cmd unavailable', exitCode: 1 };
      }
      if (args.join(' ') === 'emu finger touch 1') return '';
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      await setAndroidSetting(device, 'fingerprint', 'match');
      const flat = calls.map((args) => args.join(' '));
      assert.ok(flat.includes('shell cmd fingerprint touch 1'), flat.join('; '));
      assert.ok(flat.includes('shell cmd fingerprint finger 1'), flat.join('; '));
      assert.ok(flat.includes('emu finger touch 1'), flat.join('; '));
    },
  );
});

test('setAndroidSetting fingerprint rejects unsupported action', async () => {
  await assertRejectsAppError(() => setAndroidSetting(ANDROID_EMULATOR, 'fingerprint', 'enroll'), {
    code: 'INVALID_ARGS',
    message: /Invalid fingerprint state/,
  });
});

test('setAndroidSetting fingerprint returns COMMAND_FAILED for transport/runtime failures', async () => {
  await withFakeAdb(
    () => ({ stderr: 'error: device offline', exitCode: 1 }),
    async ({ device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'fingerprint', 'match'), {
        code: 'COMMAND_FAILED',
        message: /Failed to simulate Android fingerprint/,
      });
    },
  );
});

test('setAndroidSetting fingerprint does not use adb emu command on physical devices', async () => {
  await withFakeAdb(
    () => ({ stderr: 'unknown command', exitCode: 1 }),
    async ({ calls, device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'fingerprint', 'match'), {
        code: 'UNSUPPORTED_OPERATION',
        message: /Android fingerprint simulation is not supported/,
      });
      const emuCalls = calls.filter((args) => args[0] === 'emu');
      assert.deepEqual(emuCalls, []);
    },
    {
      device: {
        platform: 'android',
        id: 'R5CT11',
        name: 'Pixel Device',
        kind: 'device',
        booted: true,
      },
    },
  );
});

// --- settings text-size: the shared ladder mapped onto the `font_scale` multiplier ---

const GET = 'shell settings get system font_scale';

/** A device that holds a `font_scale` row, answering `get` and `put` the way `settings` does. */
function fontScaleStore(
  initial: string | null,
): Readonly<{ script: FakeAdbScript; held: () => string | null }> {
  let held = initial;
  const script: FakeAdbScript = (args) => {
    const flat = args.join(' ');
    if (flat === GET) return held ?? 'null';
    const put = /^shell settings put system font_scale (\S+)$/.exec(flat);
    if (put?.[1] !== undefined) {
      held = put[1];
      return '';
    }
    return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
  };
  return { script, held: () => held };
}

test('setAndroidSetting text-size puts the category multiplier and reports it', async () => {
  const store = fontScaleStore('1.0');
  await withFakeAdb(store.script, async ({ calls, device }) => {
    const result = await setAndroidSetting(device, 'text-size', 'accessibility-large');
    assert.deepEqual(result, {
      setting: 'text-size',
      category: 'accessibility-large',
      platformValue: '1.75',
    });
    assert.equal(store.held(), '1.75');
    assert.deepEqual(
      calls.map((args) => args.join(' ')),
      ['shell settings put system font_scale 1.75'],
    );
  });
});

test('setAndroidSetting text-size names the category it wrote rather than reading it back', async () => {
  // `settings put` is asynchronous inside the device: an immediate `settings get` can still answer
  // with the previous multiplier, so the write reports what it applied instead of verifying it.
  const store = fontScaleStore('1.0');
  await withFakeAdb(store.script, async ({ calls, device }) => {
    const result = await setAndroidSetting(device, 'text-size', 'extra-small');
    assert.deepEqual(result, {
      setting: 'text-size',
      category: 'extra-small',
      platformValue: '0.82',
    });
    assert.equal(
      calls.some((args) => args.join(' ') === GET),
      false,
    );
  });
});

test('setAndroidSetting text-size sends the normalized category, not the caller casing', async () => {
  const store = fontScaleStore('1.0');
  await withFakeAdb(store.script, async ({ calls, device }) => {
    await setAndroidSetting(device, 'text-size', ' Extra-Small ');
    assert.deepEqual(
      calls.map((args) => args.join(' ')),
      ['shell settings put system font_scale 0.82'],
    );
  });
});

test('setAndroidSetting text-size refuses an off-ladder category without touching the device', async () => {
  const store = fontScaleStore('1.0');
  await withFakeAdb(store.script, async ({ calls, device }) => {
    await assertRejectsAppError(() => setAndroidSetting(device, 'text-size', 'gigantic'), {
      code: 'INVALID_ARGS',
      message: /Invalid text-size state: gigantic/,
    });
    assert.deepEqual(calls, []);
    assert.equal(store.held(), '1.0');
  });
});

// The mapping itself, written out rung by rung rather than derived from the implementation: the
// multipliers are the claim this file exists to keep, in both directions, and an off-by-one or a
// transposed rung changes a rendered font size on a real device.
const FONT_SCALE_LADDER = [
  ['extra-small', '0.82'],
  ['small', '0.88'],
  ['medium', '0.94'],
  ['large', '1.0'],
  ['extra-large', '1.12'],
  ['extra-extra-large', '1.24'],
  ['extra-extra-extra-large', '1.35'],
  ['accessibility-medium', '1.5'],
  ['accessibility-large', '1.75'],
  ['accessibility-extra-large', '2.0'],
  ['accessibility-extra-extra-large', '2.5'],
  ['accessibility-extra-extra-extra-large', '3.2'],
] as const;

test('the font_scale ladder maps every category to its own multiplier and back', async () => {
  assert.deepEqual(
    FONT_SCALE_LADDER.map(([category]) => category),
    [...TEXT_SIZE_CATEGORIES],
  );
  for (const [category, fontScale] of FONT_SCALE_LADDER) {
    const store = fontScaleStore('1.0');
    await withFakeAdb(store.script, async ({ calls, device }) => {
      await setAndroidSetting(device, 'text-size', category);
      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [`shell settings put system font_scale ${fontScale}`],
      );
      const read = await readAndroidSetting(device, 'text-size');
      assert.deepEqual(read, { setting: 'text-size', category, platformValue: fontScale });
    });
  }
});

test('readAndroidSetting text-size reports the multiplier the device holds', async () => {
  await withFakeAdb(fontScaleStore('2').script, async ({ calls, device }) => {
    const result = await readAndroidSetting(device, 'text-size');
    assert.deepEqual(result, {
      setting: 'text-size',
      category: 'accessibility-extra-large',
      platformValue: '2',
    });
    assert.deepEqual(
      calls.map((args) => args.join(' ')),
      [GET],
    );
  });
});

test('readAndroidSetting text-size treats the null sentinel as the Android default, large', async () => {
  // `settings get system font_scale` prints `null` for a row that was never written; Android's own
  // default multiplier is 1.0, which is the rung the ladder calls `large`.
  for (const unset of ['null', ' null \n']) {
    await withFakeAdb(fontScaleStore(unset).script, async ({ device }) => {
      const result = await readAndroidSetting(device, 'text-size');
      assert.deepEqual(result, { setting: 'text-size', category: 'large', platformValue: '1.0' });
    });
  }
});

test('readAndroidSetting text-size names the nearest rung for a multiplier it never wrote', async () => {
  // 1.2 is between extra-extra-large (1.24) and extra-large (1.12), and closer to 1.24. The exact
  // multiplier rides along so a normalized answer stays auditable against the device.
  await withFakeAdb(fontScaleStore('1.2').script, async ({ device }) => {
    const result = await readAndroidSetting(device, 'text-size');
    assert.deepEqual(result, {
      setting: 'text-size',
      category: 'extra-extra-large',
      platformValue: '1.2',
    });
  });
});

test('readAndroidSetting text-size clamps a multiplier beyond both ends of the ladder', async () => {
  await withFakeAdb(fontScaleStore('0.4').script, async ({ device }) => {
    const result = await readAndroidSetting(device, 'text-size');
    assert.equal(result.category, 'extra-small');
    assert.equal(result.platformValue, '0.4');
  });
  await withFakeAdb(fontScaleStore('9').script, async ({ device }) => {
    const result = await readAndroidSetting(device, 'text-size');
    assert.equal(result.category, 'accessibility-extra-extra-extra-large');
    assert.equal(result.platformValue, '9');
  });
});

test('readAndroidSetting text-size fails on a multiplier it cannot order', async () => {
  // `1.2-beta` and `12 apples` are the cases a numeric-prefix parse would silently accept as 1.2
  // and 12, reporting a confident rung for a value the device never held in a usable form.
  // Empty output is a read that saw nothing, not a device holding its default: only the `null`
  // sentinel means that, and guessing would report a size nobody asked the device to hold.
  for (const held of ['', '   ', 'standard', '1.2-beta', '12 apples', '-1', '0']) {
    await withFakeAdb(fontScaleStore(held).script, async ({ device }) => {
      await assertRejectsAppError(() => readAndroidSetting(device, 'text-size'), {
        code: 'COMMAND_FAILED',
        message: /unusable font scale/,
      });
    });
  }
});

// --- settings mobile-data: `svc data` with a read-back of the global `mobile_data` row ---

const GET_MOBILE_DATA = 'shell settings get global mobile_data';

/**
 * A single-SIM telephony service holding `held` in `mobile_data` (`null` when absent). It stores a
 * `svc data` write after `visibleAfterReads` further reads, or never with `honorWrites: false`.
 */
function telephonyService(
  held: string,
  options: { honorWrites?: boolean; visibleAfterReads?: number } = {},
): FakeAdbScript {
  let stored = held;
  let pending: string | undefined;
  let readsUntilVisible = 0;
  return (args) => {
    const flat = args.join(' ');
    if (flat === GET_MOBILE_DATA) {
      if (pending !== undefined && readsUntilVisible-- <= 0) {
        stored = pending;
        pending = undefined;
      }
      return stored;
    }
    if (flat === 'shell svc data enable' || flat === 'shell svc data disable') {
      if (options.honorWrites !== false) {
        pending = flat.endsWith('enable') ? '1' : '0';
        readsUntilVisible = options.visibleAfterReads ?? 0;
      }
      return '';
    }
    return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
  };
}

/** Advances the faked wall clock past the settle budget on every read of the row. */
function expiringOnRead(script: FakeAdbScript): FakeAdbScript {
  return (args, options) => {
    if (args.join(' ') === GET_MOBILE_DATA) vi.setSystemTime(Date.now() + 2_500);
    return script(args, options);
  };
}

async function withFakeWallClock(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ now: 0, toFake: ['Date'] });
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

const flatCalls = (calls: (readonly string[])[]) => calls.map((args) => args.join(' '));

test('setAndroidSetting mobile-data switches through svc data and reports the stored state', async () => {
  for (const { state, held, verb, mobileData, visibleAfterReads } of [
    { state: 'off', held: '1', verb: 'disable', mobileData: 'disabled', visibleAfterReads: 0 },
    { state: 'on', held: '0', verb: 'enable', mobileData: 'enabled', visibleAfterReads: 0 },
    // The telephony service can store the switch after `svc data` returns, so the row is read again.
    { state: 'on', held: 'null', verb: 'enable', mobileData: 'enabled', visibleAfterReads: 1 },
  ]) {
    const signal = new AbortController().signal;
    const readOptions: { signal?: AbortSignal; timeoutMs?: number }[] = [];
    const script = telephonyService(held, { visibleAfterReads });
    await withFakeAdb(
      (args, options) => {
        if (args.join(' ') === GET_MOBILE_DATA) readOptions.push(options ?? {});
        return script(args, options);
      },
      async ({ calls, device }) => {
        const result = await setAndroidSetting(
          device,
          'mobile-data',
          state,
          undefined,
          undefined,
          signal,
        );
        assert.deepEqual(result, { mobileData });
        assert.deepEqual(flatCalls(calls), [
          `shell svc data ${verb}`,
          ...Array(visibleAfterReads + 1).fill(GET_MOBILE_DATA),
        ]);
      },
    );
    for (const options of readOptions) {
      assert.equal(options.signal, signal);
      assert.ok(options.timeoutMs !== undefined && options.timeoutMs <= 2000);
    }
  }
});

test('setAndroidSetting mobile-data fails on the last read when the switch never settles', async () => {
  for (const { held, reason, mobileData } of [
    { held: '0', reason: 'mobile-data-not-applied', mobileData: 'disabled' },
    { held: 'null', reason: 'mobile-data-unreadable', mobileData: undefined },
  ]) {
    await withFakeWallClock(async () => {
      const script = expiringOnRead(telephonyService(held, { honorWrites: false }));
      await withFakeAdb(script, async ({ device }) => {
        await assert.rejects(setAndroidSetting(device, 'mobile-data', 'on'), (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.equal(error.details?.reason, reason);
          assert.equal(error.details?.storedValue, held);
          assert.equal(error.details?.mobileData, mobileData);
          assert.equal(error.details?.dispatched, 'unknown');
          return true;
        });
      });
    });
  }
});

test('setAndroidSetting mobile-data discloses a possible switch when svc data fails', async () => {
  await withFakeAdb(
    (args) =>
      args.join(' ') === 'shell svc data enable'
        ? { stderr: "cmd: Can't find service: phone", exitCode: 20 }
        : undefined,
    async ({ calls, device }) => {
      await assertRejectsAppError(() => setAndroidSetting(device, 'mobile-data', 'on'), {
        code: 'COMMAND_FAILED',
        dispatched: 'unknown',
      });
      assert.deepEqual(flatCalls(calls), ['shell svc data enable']);
    },
  );
});

test('setAndroidSetting mobile-data runs nothing for a bad state or a request cancelled up front', async () => {
  const controller = new AbortController();
  controller.abort();
  await withFakeAdb(telephonyService('1'), async ({ calls, device }) => {
    await assertRejectsAppError(() => setAndroidSetting(device, 'mobile-data', 'cellular'), {
      code: 'INVALID_ARGS',
      message: /Invalid setting state: cellular/,
    });
    await assert.rejects(
      setAndroidSetting(device, 'mobile-data', 'off', undefined, undefined, controller.signal),
    );
    assert.deepEqual(calls, []);
  });
});

test('setAndroidSetting mobile-data stops sampling when the request is cancelled', async () => {
  const controller = new AbortController();
  const script = telephonyService('0', { honorWrites: false });
  await withFakeAdb(
    (args, options) => {
      if (args.join(' ') === GET_MOBILE_DATA) controller.abort();
      return script(args, options);
    },
    async ({ calls, device }) => {
      await assert.rejects(
        setAndroidSetting(device, 'mobile-data', 'on', undefined, undefined, controller.signal),
      );
      assert.equal(flatCalls(calls).filter((call) => call === GET_MOBILE_DATA).length, 1);
    },
  );
});
