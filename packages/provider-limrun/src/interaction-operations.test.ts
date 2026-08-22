import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test } from 'vitest';
import { limrunNavigationOperationFacts } from './interaction-operations.ts';

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
