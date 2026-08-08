import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { afterEach, beforeEach, test, vi } from 'vitest';

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn() };
});

vi.mock('../../../utils/timeouts.ts', () => ({ sleep: vi.fn() }));

import {
  closeHarmonyApp,
  getHarmonyAppState,
  installHarmonyApp,
  listHarmonyApps,
  parseHarmonyIsSystemApp,
  openHarmonyApp,
  parseHarmonyBundleList,
  parseHarmonyForegroundApp,
  parseHarmonyLaunchTarget,
  resolveHarmonyArchiveBundleName,
} from '../app-lifecycle.ts';
import { runCmd } from '../../../utils/exec.ts';
import { sleep } from '../../../utils/timeouts.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockSleep = vi.mocked(sleep);

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
  mockRunCmd.mockReset();
  mockSleep.mockReset();
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

test('parseHarmonyForegroundApp reads the foreground ability from the mission list', () => {
  assert.deepEqual(
    parseHarmonyForegroundApp(`
      Mission ID #57  mission name #[#com.huawei.hmos.settings:phone_settings:com.huawei.hmos.settings.MainAbility]
        state #BACKGROUND
      Mission ID #76  mission name #[#com.example.application:entry:EntryAbility]
        state #FOREGROUND
    `),
    { package: 'com.example.application', activity: 'EntryAbility' },
  );
});

test('parseHarmonyForegroundApp rejects a mission list without a foreground ability', () => {
  assert.equal(parseHarmonyForegroundApp('Mission ID #57 state #BACKGROUND'), undefined);
});

test('resolveHarmonyArchiveBundleName reads module metadata through unzip', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ app: { bundleName: 'com.example.application' } }),
    stderr: '',
  } as Awaited<ReturnType<typeof runCmd>>);

  await assert.doesNotReject(async () => {
    assert.equal(
      await resolveHarmonyArchiveBundleName('/tmp/example.hap'),
      'com.example.application',
    );
  });
  assert.deepEqual(mockRunCmd.mock.calls[0]?.slice(0, 2), [
    'unzip',
    ['-p', '/tmp/example.hap', 'module.json'],
  ]);
});

test('HarmonyOS lifecycle commands use HDC bundle and ability primitives', async () => {
  mockRunCmd
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'com.example.application\n', stderr: '' })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout:
        'Mission ID #1 mission name #[#com.example.application:entry:EntryAbility]\nstate #FOREGROUND',
      stderr: '',
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'start ability successfully', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

  assert.deepEqual(await listHarmonyApps(DEVICE, 'all'), [
    { package: 'com.example.application', name: 'application' },
  ]);
  assert.deepEqual(await getHarmonyAppState(DEVICE), {
    package: 'com.example.application',
    activity: 'EntryAbility',
  });
  await openHarmonyApp(DEVICE, 'com.example.application', { activity: 'EntryAbility' });
  await closeHarmonyApp(DEVICE, 'com.example.application');

  assert.deepEqual(
    mockRunCmd.mock.calls.map(([, args]) => args),
    [
      ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a'],
      ['-t', 'harmony-1', 'shell', 'aa', 'dump', '-l'],
      [
        '-t',
        'harmony-1',
        'shell',
        'aa',
        'start',
        '-a',
        'EntryAbility',
        '-b',
        'com.example.application',
      ],
      ['-t', 'harmony-1', 'shell', 'aa', 'force-stop', 'com.example.application'],
    ],
  );
});

test('HarmonyOS app listing filters user-installed bundles through Bundle Manager metadata', async () => {
  mockRunCmd
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'com.example.application\ncom.ohos.settings\n',
      stderr: '',
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ applicationInfo: { isSystemApp: false } }),
      stderr: '',
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ applicationInfo: { isSystemApp: true } }),
      stderr: '',
    });

  assert.deepEqual(await listHarmonyApps(DEVICE, 'user-installed'), [
    { package: 'com.example.application', name: 'application' },
  ]);
  assert.deepEqual(
    mockRunCmd.mock.calls.map(([, args]) => args),
    [
      ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a'],
      ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-n', 'com.example.application'],
      ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-n', 'com.ohos.settings'],
    ],
  );
});

test('HarmonyOS app listing preserves the complete inventory for the all filter', async () => {
  mockRunCmd.mockResolvedValueOnce({
    exitCode: 0,
    stdout: 'com.example.application\ncom.ohos.settings\n',
    stderr: '',
  });

  assert.deepEqual(await listHarmonyApps(DEVICE, 'all'), [
    { package: 'com.example.application', name: 'application' },
    { package: 'com.ohos.settings', name: 'settings' },
  ]);
  assert.deepEqual(
    mockRunCmd.mock.calls.map(([, args]) => args),
    [['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a']],
  );
});

test('HarmonyOS user-installed app listing rejects bundles without a system-app classification', async () => {
  mockRunCmd
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'com.example.application\n',
      stderr: '',
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ applicationInfo: {} }),
      stderr: '',
    });

  await assert.rejects(
    () => listHarmonyApps(DEVICE, 'user-installed'),
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
  let metadataCalls = 0;
  const abortedSignals: AbortSignal[] = [];
  mockRunCmd.mockImplementation(async (_command, args, options) => {
    if (args.at(-1) === '-a') {
      return { exitCode: 0, stdout: `${packages.join('\n')}\n`, stderr: '' } as Awaited<
        ReturnType<typeof runCmd>
      >;
    }
    metadataCalls++;
    if (args.at(-1) === 'com.example.app4') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ applicationInfo: {} }),
        stderr: '',
      } as Awaited<ReturnType<typeof runCmd>>;
    }
    const signal = options?.signal;
    assert(signal);
    abortedSignals.push(signal);
    return await new Promise<Awaited<ReturnType<typeof runCmd>>>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('metadata request aborted')), {
        once: true,
      });
    });
  });

  await assert.rejects(
    () => listHarmonyApps(DEVICE, 'user-installed'),
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
  assert.equal(abortedSignals.length, 3);
  assert(abortedSignals.every((signal) => signal.aborted));
});

test('HarmonyOS user-installed app listing aborts all metadata reads at its aggregate deadline', async () => {
  vi.useFakeTimers();
  const packages = Array.from({ length: 6 }, (_, index) => `com.example.app${index + 1}`);
  let metadataCalls = 0;
  const metadataSignals: AbortSignal[] = [];
  mockRunCmd.mockImplementation(async (_command, args, options) => {
    if (args.at(-1) === '-a') {
      return { exitCode: 0, stdout: `${packages.join('\n')}\n`, stderr: '' } as Awaited<
        ReturnType<typeof runCmd>
      >;
    }
    metadataCalls++;
    const signal = options?.signal;
    assert(signal);
    metadataSignals.push(signal);
    return await new Promise<Awaited<ReturnType<typeof runCmd>>>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('metadata request aborted')), {
        once: true,
      });
    });
  });

  const listing = listHarmonyApps(DEVICE, 'user-installed');
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
  mockRunCmd
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({
        hapModuleInfos: [{ mainElementName: 'EntryAbility', moduleName: 'entry' }],
      }),
      stderr: '',
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'start ability successfully', stderr: '' });

  await openHarmonyApp(DEVICE, 'com.example.application');
  assert.deepEqual(mockRunCmd.mock.calls[1]?.[1], [
    '-t',
    'harmony-1',
    'shell',
    'aa',
    'start',
    '-a',
    'EntryAbility',
    '-b',
    'com.example.application',
    '-m',
    'entry',
  ]);

  mockRunCmd.mockResolvedValueOnce({ exitCode: 0, stdout: 'not installed', stderr: '' });
  await assert.rejects(() => openHarmonyApp(DEVICE, 'com.example.missing'), /launchable ability/);
});

test('HarmonyOS install reads archive metadata, installs, and relaunches when requested', async () => {
  mockRunCmd
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ app: { bundleName: 'com.example.application' } }),
      stderr: '',
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ hapModuleInfos: [{ mainElementName: 'EntryAbility' }] }),
      stderr: '',
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'start ability successfully', stderr: '' });

  assert.deepEqual(await installHarmonyApp(DEVICE, '/tmp/example.hap', { relaunch: true }), {
    package: 'com.example.application',
    launchTarget: 'com.example.application',
  });
  assert.deepEqual(mockSleep.mock.calls, [[1_000]]);
  assert.deepEqual(mockRunCmd.mock.calls[1]?.[1], [
    '-t',
    'harmony-1',
    'install',
    '-r',
    '/tmp/example.hap',
  ]);
});
