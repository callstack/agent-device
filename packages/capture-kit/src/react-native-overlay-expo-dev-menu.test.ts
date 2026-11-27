import { describe, expect, test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { formatReactNativeOverlayWarning } from './react-native-overlay.ts';

function nodes(specs: Array<Partial<SnapshotNode>>): SnapshotNode[] {
  return specs.map((spec, index) => ({ index, ...spec }) as SnapshotNode);
}

/** iPhone 17 Pro simulator, `snapshot -i`: the test app's form under the Expo dev menu, trimmed. */
const IOS_MENU = nodes([
  { type: 'Application', label: 'Agent Device Tester' },
  { type: 'TextField', label: 'Email' },
  { type: 'StaticText', label: 'Agent Device Tester' },
  { type: 'Button', label: 'Close' },
  { type: 'StaticText', label: 'Runtime version: exposdk:58.0.0' },
  { type: 'Button', label: 'Reload' },
  { type: 'Button', label: 'Go home' },
]);

/** Pixel 9 emulator, full `snapshot` of an Expo dev-client app under the dev menu, trimmed. */
const ANDROID_MENU = nodes([
  { type: 'android.widget.TextView', label: 'Lab (Dev)' },
  { type: 'android.widget.TextView', label: 'Runtime version: 3.5.0' },
  { type: 'android.view.View', label: 'Close' },
  { type: 'android.view.View', label: 'Reload' },
  { type: 'android.widget.TextView', label: 'Reload' },
  { type: 'android.view.View', label: 'Home' },
  { type: 'android.widget.TextView', label: 'Go home' },
]);

/** The same Android menu in `snapshot -i`, which drops the header text. */
const ANDROID_INTERACTIVE_MENU = ANDROID_MENU.filter(
  (node) => !node.label?.startsWith('Runtime version') && node.label !== 'Lab (Dev)',
);

const DEV_MENU_HINT = /Expo dev menu looks open[\s\S]*Close[\s\S]*disableAutoLaunch=1/;

describe('the Expo dev menu hint', () => {
  test.each([
    ['the iOS simulator capture', IOS_MENU],
    ['the Android full capture', ANDROID_MENU],
    [
      'an SDK version line beside Go home only',
      nodes([{ label: 'SDK version: 58.0.0' }, { label: 'Go home' }]),
    ],
    [
      'the version line carried as a value',
      nodes([{ value: 'Runtime version: 1.0.0' }, { label: 'Reload' }]),
    ],
  ])('names the menu and its Close for %s', (_name, captured) => {
    expect(formatReactNativeOverlayWarning(captured)).toMatch(DEV_MENU_HINT);
  });

  test.each([
    ["Android's interactive capture, which drops the version line", ANDROID_INTERACTIVE_MENU],
    [
      'a version line with no Reload or Go home',
      nodes([{ label: 'Runtime version: 1.0.0' }, { label: 'Close' }]),
    ],
    ['an app Reload with no version line', nodes([{ label: 'Reload' }, { label: 'Close' }])],
    [
      'a version line that only mentions the words',
      nodes([{ label: 'See the runtime version: below' }, { label: 'Reload' }]),
    ],
    ['a version line with no value', nodes([{ label: 'Runtime version:' }, { label: 'Reload' }])],
  ])('stays quiet for %s', (_name, captured) => {
    expect(formatReactNativeOverlayWarning(captured)).toBeUndefined();
  });
});
