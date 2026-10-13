import { expect, test } from 'vitest';
import {
  androidSystemBarMembership,
  isAndroidSystemChromeWindowResourceId,
} from './android-system-chrome.ts';

test.each([
  ['status_bar', 'status'],
  ['status_bar_container', 'status'],
  ['status_bar_launch_animation_container', 'status'],
  ['navigation_bar', 'navigation'],
  ['navigation_bar_frame', 'navigation'],
  ['split_shade_status_bar', undefined],
  ['keyguard_status_bar', undefined],
  ['status_bar_notification_row', undefined],
  ['status_bar_expanded', undefined],
  ['status_bar_popup', undefined],
  ['navigation_bar_dialog', undefined],
  ['volume_dialog_container', undefined],
  ['status_barometer', undefined],
] as const)('public membership of %s is %s', (leaf, expected) => {
  expect(
    androidSystemBarMembership('com.android.systemui', `com.android.systemui:id/${leaf}`),
  ).toBe(expected);
});

test('bar inheritance requires SystemUI ownership at each edge', () => {
  expect(androidSystemBarMembership('com.android.systemui', undefined, 'status')).toBe('status');
  expect(androidSystemBarMembership(undefined, undefined, 'status')).toBeUndefined();
  expect(
    androidSystemBarMembership('com.example', 'com.android.systemui:id/status_bar', 'status'),
  ).toBeUndefined();
  expect(
    androidSystemBarMembership('com.android.systemui', 'com.example:id/status_bar'),
  ).toBeUndefined();
});

test('shade settle provenance is private and does not imply public bar membership', () => {
  const identifier = 'com.android.systemui:id/split_shade_status_bar';
  expect(isAndroidSystemChromeWindowResourceId(identifier)).toBe(true);
  expect(androidSystemBarMembership('com.android.systemui', identifier)).toBeUndefined();
});
