import { testIosRunner } from './ios-runner.fixtures.ts';
import { runtimeSubjectFact } from '@agent-device/contracts/platform-runtime';
import {
  HARDWARE_BUTTON_NAMES,
  parseHardwareButtonPositionals,
} from '@agent-device/contracts/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test } from 'vitest';
import { limrunAndroidSettingsFacts, limrunAppleSettingsFacts } from './interaction-operations.ts';
import {
  limrunAppLogFacts,
  limrunAppLogRecoveryFacts,
  liveSessionUnavailable,
} from './facts-runtime.ts';
import { limrunOwnerOptions } from './app-log-runtime.fixtures.ts';

function factsFor(device: DeviceInfo = iosDevice, unavailable?: unknown) {
  return (unavailable ? limrunAppLogRecoveryFacts : limrunAppLogFacts)(limrunOwnerOptions(), device)
    .operations;
}

const iosDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'limrun-ios',
  name: 'Limrun iOS',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};
const androidMobileDevice: DeviceInfo = {
  platform: 'android',
  id: 'limrun-android-mobile',
  name: 'Limrun Android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};
const androidTvDevice: DeviceInfo = {
  ...androidMobileDevice,
  id: 'limrun-android-tv',
  target: 'tv',
};

test('the Android leg admits back/orientation and gates tv-remote on a real TV target', () => {
  const mobile = factsFor(androidMobileDevice);
  expect(mobile.back).toEqual({ available: true });
  expect(mobile.setOrientation).toEqual({ available: true });
  expect(mobile.unlockOrientation).toEqual({ available: true });
  expect(mobile.tvRemote).toEqual({
    available: false,
    reason: 'unsupported-device-kind',
    hint: 'tv-remote is supported only on Android TV targets.',
  });

  const tv = factsFor(androidTvDevice);
  expect(tv.tvRemote).toEqual({ available: true });
});

test('a live session reads and writes the clipboard on both legs', () => {
  const live = factsFor();
  expect(live.readClipboard).toEqual({ available: true });
  expect(live.writeClipboard).toEqual({ available: true });

  const stale = factsFor(iosDevice, liveSessionUnavailable);
  expect(stale.readClipboard).toEqual(liveSessionUnavailable);
  expect(stale.writeClipboard).toEqual(liveSessionUnavailable);
});

test('home and app-switcher are admitted on both legs, with the Apple action button', () => {
  const android = factsFor(androidMobileDevice);
  expect(android.home).toEqual({ available: true });
  expect(android.appSwitcher).toEqual({ available: true });
  expect(android.actionButton).toMatchObject({
    available: false,
    reason: 'unsupported-provider-mode',
  });

  const ios = factsFor(iosDevice);
  expect(ios.home).toEqual({ available: true });
  expect(ios.appSwitcher).toEqual({ available: true });
  expect(ios.actionButton).toEqual({ available: true });

  const stale = factsFor(androidMobileDevice, liveSessionUnavailable);
  expect(stale.home).toEqual(liveSessionUnavailable);
  expect(stale.appSwitcher).toEqual(liveSessionUnavailable);
  expect(stale.actionButton).toEqual(liveSessionUnavailable);
});

// The Android leg's interactor comes from createAndroidInteractor, which carries every
// hardware-button press, so a leased phone/tablet admits them all with the local owner's phone
// and TV rule; the iOS leg has no such member and falls to the family denial (#3848).
test('the Android leg admits the hardware-button presses and gates them on the local rule', () => {
  const cells = HARDWARE_BUTTON_NAMES.map((name) => parseHardwareButtonPositionals([name]));
  const android = factsFor(androidMobileDevice);
  for (const cell of cells) {
    expect(android[cell]).toEqual({ available: true });
  }

  const tv = factsFor(androidTvDevice);
  for (const cell of cells) {
    expect(tv[cell]).toEqual({
      available: false,
      reason: 'unsupported-device-kind',
      hint: 'hardware-button is not supported on Android TV targets; use tv-remote.',
    });
  }

  const ios = factsFor(iosDevice);
  expect(ios.volumeUp).toMatchObject({
    available: false,
    reason: 'unsupported-device-kind',
  });
  expect(ios.mediaPlayPause).toMatchObject({
    available: false,
    reason: 'unsupported-platform-leaf',
  });

  const stale = factsFor(androidMobileDevice, liveSessionUnavailable);
  for (const cell of cells) {
    expect(stale[cell]).toEqual(liveSessionUnavailable);
  }
});

// R57: app-event delivery is the one system leaf BOTH direct-session legs serve, because each
// implements `open` and a deep link is exactly what that method routes.
test('app-event delivery is admitted on both direct-session legs', () => {
  expect(factsFor(androidMobileDevice).triggerAppEvent).toEqual({
    available: true,
  });
  expect(factsFor(iosDevice).triggerAppEvent).toEqual({ available: true });
  expect(factsFor(iosDevice, liveSessionUnavailable).triggerAppEvent).toEqual(
    liveSessionUnavailable,
  );
});

test('iOS inherits shared settings except unavailable keychain reset', () => {
  const android = limrunAndroidSettingsFacts();
  expect(runtimeSubjectFact(android.setSetting, 'animations').available).toBe(true);
  const ios = limrunAppleSettingsFacts(testIosRunner.facts);
  for (const setting of [
    'appearance',
    'wifi',
    'airplane',
    'permission',
    'location',
    'text-size',
    'faceid',
    'touchid',
  ]) {
    expect(runtimeSubjectFact(ios.setSetting, setting).available).toBe(true);
  }
  expect(runtimeSubjectFact(ios.setSetting, 'reset-keychain').available).toBe(false);
  expect(runtimeSubjectFact(ios.readSetting, 'text-size').available).toBe(true);
  expect(limrunAndroidSettingsFacts(liveSessionUnavailable).setSetting).toEqual(
    liveSessionUnavailable,
  );
  expect(limrunAndroidSettingsFacts(liveSessionUnavailable).readSetting).toEqual(
    liveSessionUnavailable,
  );
});

// R59 split, then #3349 closed the iOS half: the Android leg reuses the local family's
// interactor, and the iOS direct session reads system alerts from its element-tree capture and
// presses their buttons through its touch seam, so a live session serves all four legs on both
// platforms.
test('alert legs are available on both legs of a live session and refused without one', () => {
  for (const leg of ['readAlert', 'awaitAlert', 'acceptAlert', 'dismissAlert'] as const) {
    expect(factsFor(androidMobileDevice)[leg]).toEqual({ available: true });
    expect(factsFor(iosDevice)[leg]).toEqual({ available: true });
    expect(factsFor(androidMobileDevice, liveSessionUnavailable)[leg]).toEqual(
      liveSessionUnavailable,
    );
    expect(factsFor(iosDevice, liveSessionUnavailable)[leg]).toEqual(liveSessionUnavailable);
  }
});

test('the iOS leg admits back/orientation but explicitly refuses tv-remote', () => {
  const facts = factsFor(iosDevice);
  expect(facts.back).toEqual({ available: true });
  expect(facts.setOrientation).toEqual({ available: true });
  expect(facts.unlockOrientation.available).toBe(false);
  expect(facts.tvRemote).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: 'tv-remote is supported only on tvOS devices.',
  });
});

test('a dead session closes all three navigation cells with the same reason regardless of platform', () => {
  const facts = factsFor(androidTvDevice, liveSessionUnavailable);
  expect(facts.back).toEqual(liveSessionUnavailable);
  expect(facts.setOrientation).toEqual(liveSessionUnavailable);
  expect(facts.unlockOrientation).toEqual(liveSessionUnavailable);
  expect(facts.tvRemote).toEqual(liveSessionUnavailable);
});

test('binds only the operations the facts admitted, driving the resolved interactor', async () => {
  const calls: string[] = [];
  const interactor = {
    back: async (mode: string | undefined) => {
      calls.push(`back:${mode ?? 'default'}`);
    },
    home: async () => {
      calls.push('home');
    },
    setOrientation: async (rotation: string) => {
      calls.push(`setOrientation:${rotation}`);
      return undefined;
    },
    tvRemote: async () => {
      calls.push('tvRemote');
    },
  } as unknown as Interactor;
  const getInteractor = (_device: DeviceInfo, _runner?: RunnerContext) => interactor;
  const facts = {
    ...factsFor(androidTvDevice),
    ...factsFor(androidTvDevice),
  };

  const operations = bindAdmittedProviderInteractorOperations({
    device: androidTvDevice,
    signal: new AbortController().signal,
    resolveInteractor: (runner) => getInteractor(androidTvDevice, runner),
    facts,
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.home).toBeTypeOf('function');
  expect(operations.setOrientation).toBeTypeOf('function');
  expect(operations.tvRemote).toBeTypeOf('function');

  await operations.back?.({});
  await operations.home?.({});
  await operations.setOrientation?.({ rotation: 'landscape-left' });
  await operations.tvRemote?.({ button: 'select' });

  expect(calls).toEqual(['back:default', 'home', 'setOrientation:landscape-left', 'tvRemote']);
});

test('binding omits every operation an unavailable fact refused', () => {
  const facts = {
    ...factsFor(iosDevice),
    ...factsFor(iosDevice),
  };
  const operations = bindAdmittedProviderInteractorOperations({
    device: iosDevice,
    signal: new AbortController().signal,
    resolveInteractor: () => ({}) as unknown as Interactor,
    facts,
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.setOrientation).toBeTypeOf('function');
  expect(operations.home).toBeTypeOf('function');
  expect(operations.appSwitcher).toBeTypeOf('function');
  expect(operations.tvRemote).toBeUndefined();
});

test('long press is admitted on both direct-session legs and closed with a dead session', () => {
  expect(factsFor(iosDevice).longPressPoint).toEqual({ available: true });
  expect(factsFor(androidMobileDevice).longPressPoint).toEqual({
    available: true,
  });
  expect(factsFor(iosDevice, liveSessionUnavailable).longPressPoint).toEqual(
    liveSessionUnavailable,
  );
});
