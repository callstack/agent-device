import { expect, test, vi } from 'vitest';
import { clipboardRuntimeOperationFacts } from '@agent-device/contracts/clipboard-runtime';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import {
  clipboardReadUse,
  clipboardWriteUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import { makeSession, makeSessionStore, mockResolveTargetDevice } from './session-test-harness.ts';
import { handleSessionClipboardCommand } from '../session-clipboard.ts';

// File-scoped id, not a shared literal: this owner binding's `local-family` kind reaches the real
// on-disk device-claim admission (`require-owner` policy), so a shared id risks a cross-file claim
// collision under parallel test-file execution.
const androidDevice: DeviceInfo = {
  id: 'clipboard-runtime-5554',
  name: 'Pixel',
  platform: 'android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf' as const,
  hint: 'clipboard is supported on Apple simulators and the macOS host, not on physical devices of this OS.',
});

function harness(
  facts: Readonly<{ read: RuntimeOperationFact; write: RuntimeOperationFact }>,
  device: DeviceInfo = androidDevice,
) {
  const readClipboard = vi.fn(async () => 'copied text');
  const writeClipboard = vi.fn(async () => undefined);
  const runtimeFacts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: clipboardRuntimeOperationFacts(
      facts,
    ) as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device,
    owner: localRuntimeOwner(device.platform as never),
    facts: runtimeFacts,
    operations: { readClipboard, writeClipboard },
    [Symbol.asyncDispose]: async () => {},
  } satisfies DeviceBinding<PlatformRuntimeOperations>;
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => runtimeFacts);
  const bindDevice = vi.fn(async (_device, use) =>
    narrowDeviceBinding(binding, use),
  ) as unknown as BindDeviceRuntime;
  return { readClipboard, writeClipboard, inspectFacts, bindDevice };
}

function request(positionals: string[]) {
  const sessionName = 'clipboard-session';
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName, androidDevice));
  mockResolveTargetDevice.mockResolvedValue(androidDevice);
  return {
    sessionName,
    sessionStore,
    req: {
      token: 't',
      session: sessionName,
      command: 'clipboard',
      positionals,
      flags: {},
    },
    logPath: '/tmp/daemon.log',
  } as const;
}

test('clipboard read admits clipboardReadUse and reports the platform-labelled text', async () => {
  const spies = harness({ read: available, write: available });
  const response = await handleSessionClipboardCommand({ ...request(['read']), ...spies });

  expect(response.ok).toBe(true);
  expect(response.ok && response.data).toEqual({
    platform: 'android',
    action: 'read',
    text: 'copied text',
  });
  expect(spies.bindDevice).toHaveBeenCalledWith(androidDevice, clipboardReadUse);
  expect(spies.writeClipboard).not.toHaveBeenCalled();
});

test('clipboard write joins its positionals and reports the code-point length', async () => {
  const spies = harness({ read: available, write: available });
  const response = await handleSessionClipboardCommand({
    ...request(['write', 'hello', 'wörld']),
    ...spies,
  });

  expect(response.ok).toBe(true);
  expect(spies.writeClipboard).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'hello wörld' }),
  );
  expect(response.ok && response.data).toMatchObject({
    platform: 'android',
    action: 'write',
    textLength: 11,
  });
  expect(spies.bindDevice).toHaveBeenCalledWith(androidDevice, clipboardWriteUse);
  expect(spies.readClipboard).not.toHaveBeenCalled();
});

// `clipboard write ""` clears the clipboard, so an empty string is a value the command must
// forward — not the missing argument the length check would otherwise reject.
test('clipboard write forwards an explicit empty string as a clear', async () => {
  const spies = harness({ read: available, write: available });
  const response = await handleSessionClipboardCommand({ ...request(['write', '']), ...spies });

  expect(response.ok).toBe(true);
  expect(spies.writeClipboard).toHaveBeenCalledWith(expect.objectContaining({ text: '' }));
  expect(response.ok && response.data).toMatchObject({ action: 'write', textLength: 0 });
});

// ADR 0019 §9: the parsed subcommand selects exactly one use, so a request inspects facts once
// and binds once — never both halves, and never a bind per operation.
test.each([{ positionals: ['read'] }, { positionals: ['write', 'text'] }])(
  'clipboard $positionals.0 inspects facts once and binds once',
  async ({ positionals }) => {
    const spies = harness({ read: available, write: available });
    await handleSessionClipboardCommand({ ...request(positionals), ...spies });

    expect(spies.inspectFacts).toHaveBeenCalledTimes(1);
    expect(spies.bindDevice).toHaveBeenCalledTimes(1);
  },
);

test('an unadmitted cell refuses with the retired capability gate wording and its owner hint', async () => {
  const spies = harness({ read: unavailable, write: unavailable });
  const response = await handleSessionClipboardCommand({ ...request(['read']), ...spies });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toBe('clipboard is not supported on this device');
    expect(response.error.hint).toBe(unavailable.hint);
  }
  expect(spies.bindDevice).not.toHaveBeenCalled();
});

// Read and write are separate cells: a write-only refusal must not take the read down with it.
test('a write-only refusal still admits the read', async () => {
  const spies = harness({ read: available, write: unavailable });

  const write = await handleSessionClipboardCommand({
    ...request(['write', 'text']),
    ...spies,
  });
  expect(write.ok).toBe(false);

  const read = await handleSessionClipboardCommand({ ...request(['read']), ...spies });
  expect(read.ok).toBe(true);
});

test('an unknown subcommand fails before any device is resolved', async () => {
  const spies = harness({ read: available, write: available });
  const response = await handleSessionClipboardCommand({ ...request(['paste']), ...spies });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe('clipboard requires a subcommand: read or write');
  }
  expect(spies.inspectFacts).not.toHaveBeenCalled();
});

// The retired leaf validated argument counts inside `dispatchCommand`, downstream of admission,
// so an over-argued read on an admitted device still reaches that same rejection.
test('clipboard read rejects extra arguments', async () => {
  const spies = harness({ read: available, write: available });
  await expect(
    handleSessionClipboardCommand({ ...request(['read', 'extra']), ...spies }),
  ).rejects.toThrow('clipboard read does not accept additional arguments');
});

test('clipboard write with no text argument reports how to clear instead', async () => {
  const spies = harness({ read: available, write: available });
  await expect(handleSessionClipboardCommand({ ...request(['write']), ...spies })).rejects.toThrow(
    'clipboard write requires text (use "" to clear clipboard)',
  );
});
