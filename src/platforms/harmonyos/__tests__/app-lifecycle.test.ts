import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

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
  mockRunCmd.mockReset();
  mockSleep.mockReset();
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
