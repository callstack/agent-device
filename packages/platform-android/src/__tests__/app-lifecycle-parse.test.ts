import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseAndroidLaunchComponent } from '../app-lifecycle.ts';

test('parseAndroidLaunchComponent extracts final resolved components', () => {
  const stdout = [
    'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true',
    'com.boatsgroup.boattrader/com.boatsgroup.boattrader.MainActivity',
  ].join('\n');
  assert.equal(
    parseAndroidLaunchComponent(stdout),
    'com.boatsgroup.boattrader/com.boatsgroup.boattrader.MainActivity',
  );
  const multiEntry = [
    'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true',
    'com.microsoft.office.outlook/com.microsoft.office.outlook.ui.miit.MiitLauncherActivity',
  ].join('\n');
  assert.equal(
    parseAndroidLaunchComponent(multiEntry),
    'com.microsoft.office.outlook/com.microsoft.office.outlook.ui.miit.MiitLauncherActivity',
  );
});

test('parseAndroidLaunchComponent returns null when no component is present', () => {
  assert.equal(parseAndroidLaunchComponent('No activity found'), null);
});
