import { expect, test } from 'vitest';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { createRuntimeStateHandle, runtimeSlot } from '@agent-device/host-kit/runtime-slots';
import { appleRunnerHost } from './runner-host.ts';
import {
  getRunnerLeaseOwnerStateDir,
  setAppleRunnerHostEnvironment,
  setRunnerLeaseOwnerStateDir,
} from './runner-owner-state.ts';

const SLOT = Symbol('test-slot');

test('each runtime keeps its own owner state and registries', () => {
  const first = createRuntimeStateHandle();
  const second = createRuntimeStateHandle();
  const firstHost = createLiveTestHostEnvironment();
  const secondHost = createLiveTestHostEnvironment();
  first.run(() => setAppleRunnerHostEnvironment(firstHost));
  second.run(() => setAppleRunnerHostEnvironment(secondHost));

  first.run(() => {
    setRunnerLeaseOwnerStateDir(' /state/first ');
    runtimeSlot(SLOT, () => new Map<string, string>()).set('device', 'first');
  });
  second.run(() => {
    setRunnerLeaseOwnerStateDir('/state/second');
  });

  expect(first.run(() => getRunnerLeaseOwnerStateDir())).toBe('/state/first');
  expect(second.run(() => getRunnerLeaseOwnerStateDir())).toBe('/state/second');
  // Each runtime's runner host port answers from the host bound in that runtime, never the other's.
  expect(first.run(() => appleRunnerHost.hostEnvironment())).toBe(firstHost);
  expect(second.run(() => appleRunnerHost.hostEnvironment())).toBe(secondHost);
  expect(first.run(() => runtimeSlot(SLOT, () => new Map<string, string>()).get('device'))).toBe(
    'first',
  );
  expect(second.run(() => runtimeSlot(SLOT, () => new Map<string, string>()).size)).toBe(0);
  // Nothing leaked into the standalone state the code outside any runtime reads.
  expect(getRunnerLeaseOwnerStateDir()).toBeUndefined();
});

test('disposing a runtime drops its registries', () => {
  const runtime = createRuntimeStateHandle();
  runtime.run(() => runtimeSlot(SLOT, () => new Map([['device', 'owned']])));

  runtime.dispose();

  expect(runtime.run(() => runtimeSlot(SLOT, () => new Map<string, string>()).size)).toBe(0);
});

// A configuration read outside every composed runtime has no host to answer from; it refuses
// instead of borrowing the process environment (#3794).
test('the runner host port refuses a configuration read outside any entered runtime', () => {
  const error = (() => {
    try {
      appleRunnerHost.hostEnvironment();
      return undefined;
    } catch (error) {
      return error as AppError;
    }
  })();
  expect(error).toBeInstanceOf(AppError);
  expect(error?.details?.reason).toBe('apple_runner_host_unbound');
});
