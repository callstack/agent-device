import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn() };
});

import {
  parseHarmonyBundleList,
  parseHarmonyForegroundApp,
  parseHarmonyLaunchTarget,
  resolveHarmonyArchiveBundleName,
} from '../app-lifecycle.ts';
import { runCmd } from '../../../utils/exec.ts';

const mockRunCmd = vi.mocked(runCmd);

beforeEach(() => {
  mockRunCmd.mockReset();
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
