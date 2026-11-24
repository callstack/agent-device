import { expect, test } from 'vitest';
import { readLaunchctlJobs, uiKitApplicationBundleId } from '../launchctl-jobs.ts';

test('a launchctl list row reads as its label and pid, with no pid for a job without a process', () => {
  const output = [
    'PID\tStatus\tLabel',
    '-\t0\tcom.apple.cfprefsd',
    '412\t0\tcom.apple.SpringBoard',
    '0\t0\tcom.apple.zero',
    '1.5\t0\tcom.apple.fraction',
    '',
    '  98  -9  UIKitApplication:com.example.app[1a2b][rb-legacy]  ',
    'truncated',
  ].join('\n');

  expect(readLaunchctlJobs(output)).toEqual([
    { label: 'Label', pid: undefined },
    { label: 'com.apple.cfprefsd', pid: undefined },
    { label: 'com.apple.SpringBoard', pid: 412 },
    { label: 'com.apple.zero', pid: undefined },
    { label: 'com.apple.fraction', pid: undefined },
    { label: 'UIKitApplication:com.example.app[1a2b][rb-legacy]', pid: 98 },
  ]);
});

test.for([
  { label: 'UIKitApplication:com.example.app[1a2b][rb-legacy]', bundleId: 'com.example.app' },
  {
    label: 'UIKitApplication:com.example.app.beta[ff][rb-legacy]',
    bundleId: 'com.example.app.beta',
  },
  { label: 'UIKitApplication:com.example.app', bundleId: undefined },
  { label: 'com.apple.SpringBoard', bundleId: undefined },
  { label: 'x.UIKitApplication:com.example.app[1a2b]', bundleId: undefined },
])('$label names the app $bundleId', ({ label, bundleId }) => {
  expect(uiKitApplicationBundleId(label)).toBe(bundleId);
});
