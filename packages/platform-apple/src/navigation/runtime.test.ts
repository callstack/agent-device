import { expect, test, vi } from 'vitest';
import { INTERACTOR_OPERATIONS } from '@agent-device/contracts/interactor-operation-catalog';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { runtimeSubjectFact } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { TV_REMOTE_BUTTONS } from '@agent-device/contracts/tv-remote';
import { appleNavigationFacts, createAppleNavigationOperations } from './runtime.ts';

test('tvOS admits its navigation buttons and refuses Android-only buttons', () => {
  const fact = appleNavigationFacts({
    id: 'tvos-remote-facts',
    name: 'Apple TV',
    platform: 'apple',
    appleOs: 'tvos',
    kind: 'simulator',
    target: 'tv',
    booted: true,
  }).tvRemote;
  const supported = new Set(['up', 'down', 'left', 'right', 'select', 'menu', 'home', 'back']);
  for (const button of [...TV_REMOTE_BUTTONS, 'android-keycode:300']) {
    expect(runtimeSubjectFact(fact, button).available).toBe(supported.has(button));
  }
});

test.each(['simulator', 'device'] as const)('iOS %s refuses all TV remote buttons', (kind) => {
  const fact = appleNavigationFacts({
    id: 'ios-remote-facts',
    name: 'iPhone',
    platform: 'apple',
    appleOs: 'ios',
    kind,
    target: 'mobile',
    booted: true,
  }).tvRemote;
  expect(runtimeSubjectFact(fact, 'volume-up')).toMatchObject({ available: false });
});

test.each([
  ['ios', true],
  ['tvos', true],
  ['macos', true],
  ['watchos', true],
  ['visionos', false],
] as const)('back on %s is available: %s', (appleOs, availableExpected) => {
  const fact = appleNavigationFacts({
    id: `${appleOs}-back-facts`,
    name: appleOs,
    platform: 'apple',
    appleOs,
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  }).back;
  expect(fact.available).toBe(availableExpected);
  if (appleOs === 'visionos') {
    expect(fact).toMatchObject({
      reason: 'unsupported-platform-leaf',
      hint: expect.stringContaining('visionOS'),
    });
  }
});

test('the navigation runtime binds every catalog operation its facts admit', () => {
  // The runtime names the families it binds, so an admitted operation outside them would go unbound.
  const host = { localInteractors: { resolve: vi.fn(async () => ({}) as unknown as Interactor) } };
  const signal = new AbortController().signal;
  const devices: DeviceInfo[] = [
    {
      id: 'ios-sim',
      name: 'iPhone',
      platform: 'apple',
      appleOs: 'ios',
      kind: 'simulator',
      target: 'mobile',
      booted: true,
    },
    {
      id: 'ios-device',
      name: 'iPhone',
      platform: 'apple',
      appleOs: 'ios',
      kind: 'device',
      target: 'mobile',
      booted: true,
    },
    {
      id: 'tvos-sim',
      name: 'Apple TV',
      platform: 'apple',
      appleOs: 'tvos',
      kind: 'simulator',
      target: 'tv',
      booted: true,
    },
    {
      id: 'macos-host',
      name: 'Mac',
      platform: 'apple',
      appleOs: 'macos',
      kind: 'device',
      booted: true,
    },
  ];
  for (const device of devices) {
    const facts: Readonly<Record<string, { available: boolean }>> = appleNavigationFacts(device);
    const bound: Readonly<Record<string, unknown>> = createAppleNavigationOperations({
      host,
      device,
      signal,
      admitted: appleNavigationFacts(device),
    });
    let admitted = 0;
    for (const { operation } of INTERACTOR_OPERATIONS) {
      const fact = facts[operation];
      if (fact === undefined) continue;
      if (fact.available) admitted += 1;
      expect(typeof bound[operation], `${device.id} ${operation}`).toBe(
        fact.available ? 'function' : 'undefined',
      );
    }
    expect(admitted, device.id).toBeGreaterThan(0);
  }
});
