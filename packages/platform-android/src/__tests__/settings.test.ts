import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TEXT_SIZE_CATEGORIES } from '@agent-device/contracts/settings';
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
      if (flat === 'shell am force-stop com.example.app') return '';
      if (flat === 'shell pm clear com.example.app') return 'Success';
      return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      const result = await setAndroidSetting(device, 'clear-app-state', 'clear', 'com.example.app');
      assert.deepEqual(result, { package: 'com.example.app', cleared: true });
      assert.deepEqual(calls, [
        ['shell', 'am', 'force-stop', 'com.example.app'],
        ['shell', 'pm', 'clear', 'com.example.app'],
      ]);
    },
  );
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
      message: /Invalid text size: gigantic/,
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
