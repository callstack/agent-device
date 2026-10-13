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
  expect(
    androidSystemBarMembership('com.android.systemui', undefined, {
      bundleId: 'com.android.systemui',
      systemBar: 'status',
    }),
  ).toBe('status');
  expect(
    androidSystemBarMembership(undefined, undefined, {
      bundleId: 'com.android.systemui',
      systemBar: 'status',
    }),
  ).toBeUndefined();
  expect(
    androidSystemBarMembership('com.example', 'com.android.systemui:id/status_bar', {
      bundleId: 'com.android.systemui',
      systemBar: 'status',
    }),
  ).toBeUndefined();
  expect(
    androidSystemBarMembership('com.android.systemui', 'com.example:id/status_bar'),
  ).toBeUndefined();
});

test.each(['split_shade_status_bar', 'keyguard_status_bar'])(
  '%s settle provenance is private and does not imply public bar membership',
  (leaf) => {
    const identifier = `com.android.systemui:id/${leaf}`;
    expect(isAndroidSystemChromeWindowResourceId(identifier)).toBe(true);
    expect(androidSystemBarMembership('com.android.systemui', identifier)).toBeUndefined();
    expect(
      isAndroidSystemChromeWindowResourceId('com.android.systemui:id/status_bar_notification_row'),
    ).toBe(false);
    expect(
      isAndroidSystemChromeWindowResourceId('com.android.systemui:id/navigation_bar_dialog'),
    ).toBe(false);
  },
);

test.each(['com.android.launcher3', 'com.google.android.apps.nexuslauncher'])(
  'launcher navigation is the navbuttons subtree only: %s',
  (bundleId) => {
    expect(androidSystemBarMembership(bundleId, `${bundleId}:id/navbuttons_view`)).toBe(
      'navigation',
    );
    expect(
      androidSystemBarMembership(bundleId, `${bundleId}:id/taskbar_container`),
    ).toBeUndefined();
    expect(androidSystemBarMembership(bundleId, `${bundleId}:id/taskbar_view`)).toBeUndefined();
    expect(
      androidSystemBarMembership(bundleId, undefined, { bundleId, systemBar: 'navigation' }),
    ).toBe('navigation');
    expect(
      androidSystemBarMembership('com.example', `${bundleId}:id/navbuttons_view`),
    ).toBeUndefined();
    expect(
      androidSystemBarMembership('com.android.systemui', undefined, {
        bundleId,
        systemBar: 'navigation',
      }),
    ).toBeUndefined();
    expect(
      androidSystemBarMembership(bundleId, undefined, {
        bundleId: 'com.android.systemui',
        systemBar: 'status',
      }),
    ).toBeUndefined();
  },
);
