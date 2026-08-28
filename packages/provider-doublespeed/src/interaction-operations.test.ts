import type { Interactor } from '@agent-device/contracts/interactor-types';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { expect, test } from 'vitest';
import {
  doublespeedAlertOperationFacts,
  doublespeedAppEventOperationFacts,
  doublespeedAppSwitcherOperationFacts,
  doublespeedClipboardOperationFacts,
  doublespeedInteractionOperationFacts,
  doublespeedKeyboardOperationFacts,
  doublespeedNavigationOperationFacts,
  doublespeedSettingsOperationFacts,
} from './interaction-operations.ts';
import { doublespeedIosDevice as device } from './runtime.fixtures.ts';

const liveSessionUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'The Doublespeed provider session is no longer active for this device.',
} as const);

test('the session admits tap, long press, selector taps and scroll but no gesture plans', () => {
  const facts = doublespeedInteractionOperationFacts(device);
  expect(facts.tapPoint).toEqual({ available: true });
  expect(facts.longPressPoint).toEqual({ available: true });
  expect(facts.tapElementSelector).toEqual({ available: true });
  expect(facts.fillPoint).toEqual({ available: true });
  expect(facts.scrollDirection).toEqual({ available: true });
  expect(facts.typeText).toEqual({ available: true });
  expect(facts.focusPoint).toEqual({ available: true });
  expect(facts.tapRef).toMatchObject({ available: false, reason: 'unsupported-provider-mode' });
  expect(facts.performGesturePlan).toMatchObject({
    available: false,
    hint: 'Doublespeed iOS sessions do not expose portable gesture execution yet.',
  });
});

test('navigation admits home and orientation but refuses back and tv-remote', () => {
  const facts = doublespeedNavigationOperationFacts(device);
  expect(facts.home).toEqual({ available: true });
  expect(facts.setOrientation).toEqual({ available: true });
  expect(facts.back).toEqual({
    available: false,
    reason: 'unsupported-provider-mode',
    hint: 'Doublespeed iOS sessions do not expose back navigation yet.',
  });
  expect(facts.tvRemote).toMatchObject({ available: false, reason: 'unsupported-provider-mode' });
});

test('a dead session closes every cell with the same reason', () => {
  const navigation = doublespeedNavigationOperationFacts(device, liveSessionUnavailable);
  expect(navigation.home).toEqual(liveSessionUnavailable);
  expect(navigation.setOrientation).toEqual(liveSessionUnavailable);
  expect(navigation.back).toEqual(liveSessionUnavailable);
  const interaction = doublespeedInteractionOperationFacts(device, liveSessionUnavailable);
  expect(interaction.tapPoint).toEqual(liveSessionUnavailable);
  expect(interaction.performGesturePlan).toEqual(liveSessionUnavailable);
  expect(doublespeedAppEventOperationFacts(device, liveSessionUnavailable).triggerAppEvent).toEqual(
    liveSessionUnavailable,
  );
});

test('system leaves the session does not serve are refused with their own wording', () => {
  expect(doublespeedAppEventOperationFacts(device).triggerAppEvent).toEqual({ available: true });
  for (const leg of ['readAlert', 'awaitAlert', 'acceptAlert', 'dismissAlert'] as const) {
    expect(doublespeedAlertOperationFacts(device)[leg]).toMatchObject({
      available: false,
      hint: 'Doublespeed iOS sessions do not expose alert inspection yet.',
    });
  }
  expect(doublespeedClipboardOperationFacts(device).readClipboard).toMatchObject({
    available: false,
  });
  expect(doublespeedSettingsOperationFacts(device).setSetting).toMatchObject({ available: false });
  expect(doublespeedAppSwitcherOperationFacts(device).appSwitcher).toMatchObject({
    available: false,
  });
  expect(doublespeedKeyboardOperationFacts(device).keyboardEnter).toMatchObject({
    available: false,
  });
});

test('binding exposes only the admitted navigation operations and drives the interactor', async () => {
  const calls: string[] = [];
  const interactor = {
    home: async () => {
      calls.push('home');
    },
    setOrientation: async (rotation: string) => {
      calls.push(`setOrientation:${rotation}`);
      return undefined;
    },
  } as unknown as Interactor;
  const operations = bindAdmittedProviderInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => interactor,
    facts: doublespeedNavigationOperationFacts(device),
  });

  expect(operations.home).toBeTypeOf('function');
  expect(operations.setOrientation).toBeTypeOf('function');
  expect(operations.back).toBeUndefined();
  expect(operations.tvRemote).toBeUndefined();
  await operations.home?.({});
  await operations.setOrientation?.({ rotation: 'landscape-left' });
  expect(calls).toEqual(['home', 'setOrientation:landscape-left']);
});
