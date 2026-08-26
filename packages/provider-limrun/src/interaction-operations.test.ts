import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test } from 'vitest';
import {
  limrunAppEventOperationFacts,
  limrunAlertOperationFacts,
  limrunSettingsOperationFacts,
  limrunAppSwitcherOperationFacts,
  limrunClipboardOperationFacts,
  limrunNavigationOperationFacts,
} from './interaction-operations.ts';

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

const liveSessionUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'The Limrun provider session is no longer active for this device.',
} as const);

test('the Android leg admits back/home/orientation and gates tv-remote on a real TV target', () => {
  const mobile = limrunNavigationOperationFacts(androidMobileDevice);
  expect(mobile.back).toEqual({ available: true });
  expect(mobile.home).toEqual({ available: true });
  expect(mobile.setOrientation).toEqual({ available: true });
  expect(mobile.tvRemote).toEqual({
    available: false,
    reason: 'unsupported-device-kind',
    hint: 'tv-remote is supported only on Android TV targets.',
  });

  const tv = limrunNavigationOperationFacts(androidTvDevice);
  expect(tv.tvRemote).toEqual({ available: true });
});

// R55: the Android leg reuses the local family's `createAndroidInteractor`, so `cmd clipboard
// get/set text` reaches the device exactly as it does locally; the iOS leg's own clipboard
// methods throw, so both halves stay unavailable there.
test('clipboard follows the same Android-reuse / iOS-refusal split its siblings do', () => {
  const android = limrunClipboardOperationFacts(androidMobileDevice);
  expect(android.readClipboard).toEqual({ available: true });
  expect(android.writeClipboard).toEqual({ available: true });

  const ios = limrunClipboardOperationFacts(iosDevice);
  const refusal = {
    available: false,
    reason: 'unsupported-provider-mode',
    hint: 'Limrun iOS direct sessions do not expose clipboard access yet.',
  };
  expect(ios.readClipboard).toEqual(refusal);
  expect(ios.writeClipboard).toEqual(refusal);

  const stale = limrunClipboardOperationFacts(androidMobileDevice, liveSessionUnavailable);
  expect(stale.readClipboard).toEqual(liveSessionUnavailable);
  expect(stale.writeClipboard).toEqual(liveSessionUnavailable);
});

// R56: same Android-reuse / iOS-refusal split.
test('app-switcher rides the Android interactor and is refused on the iOS leg', () => {
  expect(limrunAppSwitcherOperationFacts(androidMobileDevice).appSwitcher).toEqual({
    available: true,
  });
  expect(limrunAppSwitcherOperationFacts(iosDevice).appSwitcher).toEqual({
    available: false,
    reason: 'unsupported-provider-mode',
    hint: 'Limrun iOS direct sessions do not expose app switcher yet.',
  });
  expect(
    limrunAppSwitcherOperationFacts(androidMobileDevice, liveSessionUnavailable).appSwitcher,
  ).toEqual(liveSessionUnavailable);
});

// R57: app-event delivery is the one system leaf BOTH direct-session legs serve, because each
// implements `open` and a deep link is exactly what that method routes.
test('app-event delivery is admitted on both direct-session legs', () => {
  expect(limrunAppEventOperationFacts(androidMobileDevice).triggerAppEvent).toEqual({
    available: true,
  });
  expect(limrunAppEventOperationFacts(iosDevice).triggerAppEvent).toEqual({ available: true });
  expect(limrunAppEventOperationFacts(iosDevice, liveSessionUnavailable).triggerAppEvent).toEqual(
    liveSessionUnavailable,
  );
});

// R58: back to the app-switcher split — the Android leg reuses the local family's interactor,
// and the iOS direct session's own `setSetting` throws.
test('settings ride the Android interactor and are refused on the iOS leg', () => {
  expect(limrunSettingsOperationFacts(androidMobileDevice).setSetting).toEqual({ available: true });
  expect(limrunSettingsOperationFacts(iosDevice).setSetting).toEqual({
    available: false,
    reason: 'unsupported-provider-mode',
    hint: 'Limrun iOS direct sessions do not expose settings changes yet.',
  });
  expect(
    limrunSettingsOperationFacts(androidMobileDevice, liveSessionUnavailable).setSetting,
  ).toEqual(liveSessionUnavailable);
});

// R59: same split again — the Android leg reuses the local family's interactor, and the iOS
// direct session has no XCUITest runner to read a sheet from.
test('alert legs ride the Android interactor and are refused on the iOS leg', () => {
  for (const leg of ['readAlert', 'awaitAlert', 'acceptAlert', 'dismissAlert'] as const) {
    expect(limrunAlertOperationFacts(androidMobileDevice)[leg]).toEqual({ available: true });
    expect(limrunAlertOperationFacts(iosDevice)[leg]).toEqual({
      available: false,
      reason: 'unsupported-provider-mode',
      hint: 'Limrun iOS direct sessions do not expose alert inspection yet.',
    });
    expect(limrunAlertOperationFacts(androidMobileDevice, liveSessionUnavailable)[leg]).toEqual(
      liveSessionUnavailable,
    );
  }
});

test('the iOS leg admits back/orientation but explicitly refuses home and tv-remote', () => {
  const facts = limrunNavigationOperationFacts(iosDevice);
  expect(facts.back).toEqual({ available: true });
  expect(facts.setOrientation).toEqual({ available: true });
  expect(facts.home).toEqual({
    available: false,
    reason: 'unsupported-provider-mode',
    hint: 'Limrun iOS direct sessions do not expose home yet.',
  });
  expect(facts.tvRemote).toEqual({
    available: false,
    reason: 'unsupported-provider-mode',
    hint: 'Limrun iOS direct sessions do not expose tv remote control.',
  });
});

test('a dead session closes all four navigation cells with the same reason regardless of platform', () => {
  const facts = limrunNavigationOperationFacts(androidTvDevice, liveSessionUnavailable);
  expect(facts.back).toEqual(liveSessionUnavailable);
  expect(facts.home).toEqual(liveSessionUnavailable);
  expect(facts.setOrientation).toEqual(liveSessionUnavailable);
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
  const facts = limrunNavigationOperationFacts(androidTvDevice);

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
  const facts = limrunNavigationOperationFacts(iosDevice);
  const operations = bindAdmittedProviderInteractorOperations({
    device: iosDevice,
    signal: new AbortController().signal,
    resolveInteractor: () => ({}) as unknown as Interactor,
    facts,
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.setOrientation).toBeTypeOf('function');
  expect(operations.home).toBeUndefined();
  expect(operations.tvRemote).toBeUndefined();
});
