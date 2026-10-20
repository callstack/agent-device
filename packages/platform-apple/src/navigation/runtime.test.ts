import { expect, test } from 'vitest';
import { runtimeSubjectFact } from '@agent-device/contracts/platform-runtime';
import { TV_REMOTE_BUTTONS } from '@agent-device/contracts/tv-remote';
import { appleNavigationFacts } from './runtime.ts';

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
