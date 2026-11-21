import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { createHarmonyHdcRunnerStub, createHarmonyHostStub } from '../toolbox.fixtures.ts';

const { invalidateHarmonyGestureViewport } = vi.hoisted(() => ({
  invalidateHarmonyGestureViewport: vi.fn(),
}));

vi.mock('../snapshot.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../snapshot.ts')>()),
  invalidateHarmonyGestureViewport,
}));

import {
  closeHarmonyApp,
  listHarmonyApps,
  parseHarmonyIsSystemApp,
  openHarmonyApp,
  parseHarmonyBundleList,
  parseHarmonyLaunchTarget,
  resolveHarmonyArchiveBundleName,
} from '../app-lifecycle.ts';

const DEVICE = {
  platform: 'harmonyos' as const,
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

beforeEach(() => {
  vi.useRealTimers();
  invalidateHarmonyGestureViewport.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test('parseHarmonyBundleList reads package lines from bm dump output', () => {
  assert.deepEqual(
    parseHarmonyBundleList('ID: 100:\n\tcom.example.application\n\tcom.huawei.hmos.settings\n'),
    ['com.example.application', 'com.huawei.hmos.settings'],
  );
});

test('parseHarmonyLaunchTarget reads the main ability and module from bm dump output', () => {
  assert.deepEqual(
    parseHarmonyLaunchTarget(
      `com.example.application:\n${JSON.stringify({
        hapModuleInfos: [
          { moduleName: 'entry', mainElementName: 'EntryAbility' },
          { moduleName: 'feature' },
        ],
      })}`,
    ),
    { ability: 'EntryAbility', module: 'entry' },
  );
  assert.equal(parseHarmonyLaunchTarget('bundle not found'), undefined);
});

test('parseHarmonyIsSystemApp reads Bundle Manager application metadata', () => {
  assert.equal(
    parseHarmonyIsSystemApp(JSON.stringify({ applicationInfo: { isSystemApp: true } })),
    true,
  );
  assert.equal(parseHarmonyIsSystemApp(JSON.stringify({ appInfo: { isSystemApp: false } })), false);
  assert.equal(parseHarmonyIsSystemApp('bundle metadata unavailable'), undefined);
});

test('resolveHarmonyArchiveBundleName reads module metadata through unzip on the host', async () => {
  const stub = createHarmonyHostStub();
  stub.answer({
    stdout: JSON.stringify({ app: { bundleName: 'com.example.application' } }),
  });

  assert.equal(
    await resolveHarmonyArchiveBundleName(stub.toolbox.commands, '/tmp/example.hap'),
    'com.example.application',
  );
  assert.deepEqual(stub.commands[0], {
    executable: 'unzip',
    args: ['-p', '/tmp/example.hap', 'module.json'],
    env: { PATH: '/usr/bin' },
    timeoutMs: 15_000,
    allowFailure: true,
    signal: undefined,
  });
});

test('resolveHarmonyArchiveBundleName forwards the binding signal to in-flight unzip', async () => {
  const controller = new AbortController();
  const stub = createHarmonyHostStub();

  const pending = resolveHarmonyArchiveBundleName(
    stub.toolbox.commands,
    '/tmp/example.hap',
    controller.signal,
  );
  await pending;

  assert.equal(stub.commands[0]?.signal, controller.signal);
});

test('HarmonyOS lifecycle commands use HDC bundle and ability primitives', async () => {
  const hdc = createHarmonyHdcRunnerStub([
    { stdout: 'com.example.application\n' },
    { stdout: 'start ability successfully' },
    { stdout: '' },
  ]);

  assert.deepEqual(await listHarmonyApps(hdc, DEVICE, 'all'), [
    { package: 'com.example.application', name: 'application' },
  ]);
  await openHarmonyApp(hdc, DEVICE, 'com.example.application', { activity: 'EntryAbility' });
  await closeHarmonyApp(hdc, DEVICE, 'com.example.application');

  assert.deepEqual(
    hdc.calls.map((call) => [call.kind, call.target, call.args]),
    [
      ['runShell', 'harmony-1', ['bm', 'dump', '-a']],
      [
        'runShell',
        'harmony-1',
        ['aa', 'start', '-a', 'EntryAbility', '-b', 'com.example.application'],
      ],
      ['runShell', 'harmony-1', ['aa', 'force-stop', 'com.example.application']],
    ],
  );
  assert.deepEqual(invalidateHarmonyGestureViewport.mock.calls, [[DEVICE], [DEVICE]]);
});

test('openHarmonyApp refuses an ability name outside the module grammar before any hdc call', async () => {
  const hdc = createHarmonyHdcRunnerStub();
  for (const activity of ['Entry$(id)', 'Entry;reboot', 'Entry Ability', '1Entry', 'Entry"x', '']) {
    await assert.rejects(
      () => openHarmonyApp(hdc, DEVICE, 'com.example.application', { activity }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.details?.reason === 'invalid-harmony-ability-name' &&
        error.details?.ability === activity,
    );
  }
  assert.equal(hdc.calls.length, 0);
});

test('HarmonyOS app listing filters user-installed bundles through Bundle Manager metadata', async () => {
  const hdc = createHarmonyHdcRunnerStub([
    { stdout: 'com.example.application\ncom.ohos.settings\n' },
    { stdout: JSON.stringify({ applicationInfo: { isSystemApp: false } }) },
    { stdout: JSON.stringify({ applicationInfo: { isSystemApp: true } }) },
  ]);

  assert.deepEqual(await listHarmonyApps(hdc, DEVICE, 'user-installed'), [
    { package: 'com.example.application', name: 'application' },
  ]);
  assert.deepEqual(
    hdc.calls.map((call) => call.args),
    [
      ['bm', 'dump', '-a'],
      ['bm', 'dump', '-n', 'com.example.application'],
      ['bm', 'dump', '-n', 'com.ohos.settings'],
    ],
  );
});

test('HarmonyOS app listing preserves the complete inventory for the all filter', async () => {
  const hdc = createHarmonyHdcRunnerStub([
    { stdout: 'com.example.application\ncom.ohos.settings\n' },
  ]);

  assert.deepEqual(await listHarmonyApps(hdc, DEVICE, 'all'), [
    { package: 'com.example.application', name: 'application' },
    { package: 'com.ohos.settings', name: 'settings' },
  ]);
  assert.deepEqual(
    hdc.calls.map((call) => call.args),
    [['bm', 'dump', '-a']],
  );
});

test('HarmonyOS user-installed app listing rejects bundles without a system-app classification', async () => {
  const hdc = createHarmonyHdcRunnerStub([
    { stdout: 'com.example.application\n' },
    { stdout: JSON.stringify({ applicationInfo: {} }) },
  ]);

  await assert.rejects(
    () => listHarmonyApps(hdc, DEVICE, 'user-installed'),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.details?.hint ?? '', /use apps --all to list all bundles/i);
      return true;
    },
  );
});

test('HarmonyOS user-installed app listing bounds metadata work and cancels queued work on failure', async () => {
  const packages = Array.from({ length: 6 }, (_, index) => `com.example.app${index + 1}`);
  const hdc = createHarmonyHdcRunnerStub();
  const metadataSignals: AbortSignal[] = [];
  let metadataCalls = 0;
  hdc.runShell = async (_device, words, options) => {
    if (words.at(-1) === '-a') {
      return { stdout: `${packages.join('\n')}\n`, stderr: '', exitCode: 0 };
    }
    metadataCalls += 1;
    const bundle = words.at(-1);
    if (bundle === 'com.example.app4') {
      return { stdout: JSON.stringify({ applicationInfo: {} }), stderr: '', exitCode: 0 };
    }
    const signal = options?.signal;
    assert(signal);
    metadataSignals.push(signal);
    return await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('metadata request aborted')), {
        once: true,
      });
    });
  };

  await assert.rejects(
    () => listHarmonyApps(hdc, DEVICE, 'user-installed'),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.match(
        error.message,
        /could not determine whether com\.example\.app4 is a system application/i,
      );
      assert.match(error.details?.hint ?? '', /use apps --all/i);
      return true;
    },
  );

  assert.equal(metadataCalls, 4);
  assert.equal(metadataSignals.length, 3);
  assert(metadataSignals.every((signal) => signal.aborted));
});

test('HarmonyOS user-installed app listing aborts all metadata reads at its aggregate deadline', async () => {
  vi.useFakeTimers();
  const packages = Array.from({ length: 6 }, (_, index) => `com.example.app${index + 1}`);
  const hdc = createHarmonyHdcRunnerStub();
  const metadataSignals: AbortSignal[] = [];
  let metadataCalls = 0;
  hdc.runShell = async (_device, _words, options) => {
    metadataCalls += 1;
    const signal = options?.signal;
    assert(signal);
    metadataSignals.push(signal);
    return await new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('metadata request aborted')), {
        once: true,
      });
    });
  };
  // The bundle list itself is the first shell read; answer it and let the metadata reads hang.
  const originalRunShell = hdc.runShell;
  let first = true;
  hdc.runShell = async (device, words, options) => {
    if (first && words.at(-1) === '-a') {
      first = false;
      return { stdout: `${packages.join('\n')}\n`, stderr: '', exitCode: 0 };
    }
    return await originalRunShell(device, words, options);
  };

  const listing = listHarmonyApps(hdc, DEVICE, 'user-installed');
  const listingError = listing.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(metadataCalls, 4);

  await vi.advanceTimersByTimeAsync(60_000);
  const error = await listingError;
  assert(error instanceof AppError);
  assert.match(error.message, /timed out while classifying HarmonyOS application inventory/i);
  assert.match(error.details?.hint ?? '', /use apps --all/i);
  assert.equal(metadataCalls, 4);
  assert.equal(metadataSignals.length, 4);
  assert(metadataSignals.every((signal) => signal.aborted));
});

test('HarmonyOS launch resolves module metadata and reports missing launch data', async () => {
  const hdc = createHarmonyHdcRunnerStub([
    {
      stdout: JSON.stringify({
        hapModuleInfos: [{ mainElementName: 'EntryAbility', moduleName: 'entry' }],
      }),
    },
    { stdout: 'start ability successfully' },
  ]);

  await openHarmonyApp(hdc, DEVICE, 'com.example.application');
  assert.deepEqual(hdc.calls[1]?.args, [
    'aa',
    'start',
    '-a',
    'EntryAbility',
    '-b',
    'com.example.application',
    '-m',
    'entry',
  ]);

  hdc.answer({ stdout: 'not installed' });
  await assert.rejects(
    () => openHarmonyApp(hdc, DEVICE, 'com.example.missing'),
    /launchable ability/,
  );
});
