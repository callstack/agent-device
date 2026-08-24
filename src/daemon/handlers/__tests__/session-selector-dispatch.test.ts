import { test, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  keyboardRuntimeOperationFacts,
  type KeyboardDismissResult,
} from '@agent-device/contracts/keyboard-runtime';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type RuntimeFacts,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import {
  mockDispatch,
  mockResolveTargetDevice,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from './session-test-harness.ts';
import type { SessionState } from '../../types.ts';
import { handleSessionCommands } from './session-command-harness.ts';

const available = Object.freeze({ available: true } as const);

/** Admits every keyboard operation so the ADR 0014 seam runs on real admission, not a rejection.
 * `keyboardDismiss` is overridable so a test can force the invocation itself to reject, proving
 * the frame expires before the mutating call runs rather than only after it resolves. */
function keyboardCapableRuntime(
  device: DeviceInfo,
  overrides?: Readonly<{ keyboardDismiss?: () => Promise<KeyboardDismissResult> }>,
) {
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: keyboardRuntimeOperationFacts({
      status: available,
      dismiss: available,
      enter: available,
    }) as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device,
    owner: localRuntimeOwner(device.platform),
    facts,
    operations: {
      keyboardStatus: async () => ({ kind: 'ime-probe', visible: false }),
      keyboardDismiss:
        overrides?.keyboardDismiss ??
        (async () => ({ kind: 'ime-probe', dismissed: true, visible: false })),
      keyboardEnter: async () => ({ kind: 'visibility-echo' }),
    },
    [Symbol.asyncDispose]: async () => {},
  } satisfies DeviceBinding<PlatformRuntimeOperations>;
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => facts);
  const bindDevice = vi.fn(async (_device, use) =>
    narrowDeviceBinding(binding, use),
  ) as unknown as BindDeviceRuntime;
  return { inspectFacts, bindDevice };
}

test('keyboard dismiss crosses the ADR 0014 seam while keyboard status preserves the frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'kb';
  const device: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(device);
  mockDispatch.mockResolvedValue({});
  const logPath = path.join(os.tmpdir(), 'daemon.log');
  const { inspectFacts, bindDevice } = keyboardCapableRuntime(device);

  // dismiss mutates the device → frame expires.
  sessionStore.set(sessionName, makeSession(sessionName, device));
  await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'keyboard',
      positionals: ['dismiss'],
      flags: {},
    },
    sessionName,
    logPath,
    sessionStore,
    invoke: noopInvoke,
    inspectFacts,
    bindDevice,
  });
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');

  // status is a read-only probe → frame preserved (undefined === active).
  sessionStore.set(sessionName, makeSession(sessionName, device));
  await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'keyboard',
      positionals: ['status'],
      flags: {},
    },
    sessionName,
    logPath,
    sessionStore,
    invoke: noopInvoke,
    inspectFacts,
    bindDevice,
  });
  expect(sessionStore.get(sessionName)?.refFrameState).toBeUndefined();
});

// ADR 0014 requires the frame to expire immediately before the mutating call, with no
// success-only rollback. The inner assertion pins the exact pre-invocation seam — the frame must
// already be expired by the time the mutating call is reached, not just eventually after the
// whole dispatch settles.
test('keyboard dismiss expires the frame before the invocation runs, even when it rejects', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'kb-reject';
  const device: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(device);
  const logPath = path.join(os.tmpdir(), 'daemon.log');
  const { inspectFacts, bindDevice } = keyboardCapableRuntime(device, {
    keyboardDismiss: () => {
      expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');
      return Promise.reject(new AppError('COMMAND_FAILED', 'runner timed out'));
    },
  });

  sessionStore.set(sessionName, makeSession(sessionName, device));
  await expect(
    handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'keyboard',
        positionals: ['dismiss'],
        flags: {},
      },
      sessionName,
      logPath,
      sessionStore,
      invoke: noopInvoke,
      inspectFacts,
      bindDevice,
    }),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');
});

test('keyboard requires an active session or explicit device selector', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'keyboard',
      positionals: ['status'],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(
      /keyboard requires an active session or an explicit device selector/i,
    );
  }
});

test('keyboard dismiss requires active iOS session for explicit selectors', async () => {
  const sessionStore = makeSessionStore();

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'keyboard',
      positionals: ['dismiss'],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/requires an active session/i);
  }
});
