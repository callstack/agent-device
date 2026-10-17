import { expect, test } from 'vitest';
import {
  createAppleRunnerRuntimeState,
  getRunnerLeaseOwnerStateDir,
  runnerRuntimeSlot,
  setRunnerLeaseOwnerStateDir,
} from './runner-owner-state.ts';

const SLOT = Symbol('test-slot');

test('each runtime keeps its own owner state and registries', () => {
  const first = createAppleRunnerRuntimeState();
  const second = createAppleRunnerRuntimeState();

  first.run(() => {
    setRunnerLeaseOwnerStateDir(' /state/first ');
    runnerRuntimeSlot(SLOT, () => new Map<string, string>()).set('device', 'first');
  });
  second.run(() => {
    setRunnerLeaseOwnerStateDir('/state/second');
  });

  expect(first.run(() => getRunnerLeaseOwnerStateDir())).toBe('/state/first');
  expect(second.run(() => getRunnerLeaseOwnerStateDir())).toBe('/state/second');
  expect(
    first.run(() => runnerRuntimeSlot(SLOT, () => new Map<string, string>()).get('device')),
  ).toBe('first');
  expect(second.run(() => runnerRuntimeSlot(SLOT, () => new Map<string, string>()).size)).toBe(0);
  // Nothing leaked into the standalone state the code outside any runtime reads.
  expect(getRunnerLeaseOwnerStateDir()).toBeUndefined();
});

test('disposing a runtime drops its registries', () => {
  const runtime = createAppleRunnerRuntimeState();
  runtime.run(() => runnerRuntimeSlot(SLOT, () => new Map([['device', 'owned']])));

  runtime.dispose();

  expect(runtime.run(() => runnerRuntimeSlot(SLOT, () => new Map<string, string>()).size)).toBe(0);
});
