import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isAmStartError, parseAndroidLaunchComponent } from '../app-lifecycle.ts';

test('isAmStartError only matches an error line with a known launch failure', () => {
  assert.equal(isAmStartError('', 'Error: Activity not started'), true);
  assert.equal(isAmStartError('warning\nError: unable to resolve Intent', ''), true);
  assert.equal(isAmStartError('notice: Activity not started', ''), false);
  assert.equal(isAmStartError('Activity not started', ''), false);
});

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
