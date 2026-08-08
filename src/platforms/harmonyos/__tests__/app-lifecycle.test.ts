import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseHarmonyBundleList, parseHarmonyLaunchTarget } from '../app-lifecycle.ts';

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
