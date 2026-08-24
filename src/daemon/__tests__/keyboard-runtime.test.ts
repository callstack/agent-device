import { expect, test, vi } from 'vitest';
import {
  keyboardRuntimeOperationFacts,
  type KeyboardDismissResult,
  type KeyboardEnterResult,
  type KeyboardStatusResult,
} from '@agent-device/contracts/keyboard-runtime';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import {
  keyboardDismissUse,
  keyboardEnterUse,
  keyboardStatusUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { resolveBoundKeyboardRuntime } from '../keyboard-runtime.ts';

// File-scoped ids, not the widely shared 'emulator-5554'/'ios-simulator' literals: these owner
// bindings' `local-family` kind reaches the real on-disk device-claim admission (`require-owner`
// policy), so a shared id risks a cross-file claim collision under parallel test-file execution.
const androidDevice: DeviceInfo = {
  id: 'keyboard-runtime-5554',
  name: 'Pixel',
  platform: 'android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};
const harmonyDevice: DeviceInfo = {
  id: 'harmony-emulator',
  name: 'nova',
  platform: 'harmonyos',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};
const iosDevice: DeviceInfo = {
  id: 'keyboard-runtime-ios-simulator',
  name: 'iPhone',
  platform: 'apple',
  appleOs: 'ios',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf' as const,
  hint: 'keyboard status/get is currently supported only on Android; use keyboard dismiss or enter on iOS',
});

function runtimeHarness(
  device: DeviceInfo,
  owner: string,
  facts: Readonly<{
    status: RuntimeOperationFact;
    dismiss: RuntimeOperationFact;
    enter: RuntimeOperationFact;
  }>,
) {
  const keyboardStatus = vi.fn<() => Promise<KeyboardStatusResult>>(async () => ({
    kind: 'ime-probe',
    visible: true,
  }));
  const keyboardDismiss = vi.fn<() => Promise<KeyboardDismissResult>>(async () => ({
    kind: 'ime-probe',
    dismissed: true,
    visible: false,
  }));
  const keyboardEnter = vi.fn<() => Promise<KeyboardEnterResult>>(async () => ({
    kind: 'android-acknowledged',
  }));
  const runtimeFacts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: keyboardRuntimeOperationFacts(
      facts,
    ) as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device,
    owner: localRuntimeOwner(owner as never),
    facts: runtimeFacts,
    operations: { keyboardStatus, keyboardDismiss, keyboardEnter },
    [Symbol.asyncDispose]: async () => {},
  } satisfies DeviceBinding<PlatformRuntimeOperations>;
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => runtimeFacts);
  const bindDevice = vi.fn(async (_device, use) =>
    narrowDeviceBinding(binding, use),
  ) as unknown as BindDeviceRuntime;
  return { keyboardStatus, keyboardDismiss, keyboardEnter, inspectFacts, bindDevice };
}

test('android status admits keyboardStatusUse and reports the platform-shaped state', async () => {
  const harness = runtimeHarness(androidDevice, 'android', {
    status: available,
    dismiss: available,
    enter: available,
  });
  harness.keyboardStatus.mockResolvedValue({
    kind: 'ime-probe',
    visible: true,
    inputType: 'text',
    type: 'ime',
    inputMethodPackage: 'com.google.android.inputmethod.latin',
    focusedPackage: 'com.example.app',
    focusedResourceId: 'com.example.app:id/field',
    inputOwner: 'app',
  });

  const resolved = await resolveBoundKeyboardRuntime({
    device: androidDevice,
    positionals: ['status'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(harness.bindDevice).toHaveBeenCalledWith(androidDevice, keyboardStatusUse);
  expect(await resolved.execute({})).toEqual({
    platform: 'android',
    action: 'status',
    visible: true,
    inputType: 'text',
    type: 'ime',
    inputMethodPackage: 'com.google.android.inputmethod.latin',
    focusedPackage: 'com.example.app',
    focusedResourceId: 'com.example.app:id/field',
    inputOwner: 'app',
  });
});

test('`get` is an alias for `status`', async () => {
  const harness = runtimeHarness(androidDevice, 'android', {
    status: available,
    dismiss: available,
    enter: available,
  });

  const resolved = await resolveBoundKeyboardRuntime({
    device: androidDevice,
    positionals: ['get'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  expect(harness.bindDevice).toHaveBeenCalledWith(androidDevice, keyboardStatusUse);
});

test('`return` is an alias for `enter`', async () => {
  const harness = runtimeHarness(androidDevice, 'android', {
    status: available,
    dismiss: available,
    enter: available,
  });

  const resolved = await resolveBoundKeyboardRuntime({
    device: androidDevice,
    positionals: ['return'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  expect(harness.bindDevice).toHaveBeenCalledWith(androidDevice, keyboardEnterUse);
});

test('android status is refused on iOS with the retired in-handler hint', async () => {
  const harness = runtimeHarness(iosDevice, 'apple', {
    status: unavailable,
    dismiss: available,
    enter: available,
  });

  const resolved = await resolveBoundKeyboardRuntime({
    device: iosDevice,
    positionals: ['status'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved).toEqual({
    ok: false,
    response: {
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'keyboard status is not supported on this device',
        hint: unavailable.hint,
      },
    },
  });
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('iOS dismiss reports the mechanism disclosure and its own message', async () => {
  const harness = runtimeHarness(iosDevice, 'apple', {
    status: unavailable,
    dismiss: available,
    enter: available,
  });
  harness.keyboardDismiss.mockResolvedValue({
    kind: 'mechanism',
    dismissed: true,
    visible: false,
    wasVisible: true,
    mechanism: 'dismissKey',
  });

  const resolved = await resolveBoundKeyboardRuntime({
    device: iosDevice,
    positionals: ['dismiss'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(harness.bindDevice).toHaveBeenCalledWith(iosDevice, keyboardDismissUse);
  expect(await resolved.execute({})).toEqual({
    platform: 'ios',
    action: 'dismiss',
    wasVisible: true,
    dismissed: true,
    visible: false,
    mechanism: 'dismissKey',
    message: 'Keyboard dismissed via its dismiss key',
  });
});

// #1598: the response must disclose which mechanism the runner used to resign the keyboard —
// only the keyboard's own dismiss key is a mechanism the runner vouches for; an unrecognized wire
// value must degrade to the bare message rather than a false claim.
test('iOS dismiss degrades an unrecognized mechanism to the bare message', async () => {
  const harness = runtimeHarness(iosDevice, 'apple', {
    status: unavailable,
    dismiss: available,
    enter: available,
  });
  harness.keyboardDismiss.mockResolvedValue({
    kind: 'mechanism',
    dismissed: true,
    visible: false,
    wasVisible: true,
    mechanism: 'legacySafeAreaTap',
  });

  const resolved = await resolveBoundKeyboardRuntime({
    device: iosDevice,
    positionals: ['dismiss'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const result = await resolved.execute({});
  expect(result).toMatchObject({ mechanism: 'legacySafeAreaTap', message: 'Keyboard dismissed' });
});

test('iOS dismiss omits a message mechanism claim when every mechanism failed', async () => {
  const harness = runtimeHarness(iosDevice, 'apple', {
    status: unavailable,
    dismiss: available,
    enter: available,
  });
  harness.keyboardDismiss.mockResolvedValue({
    kind: 'mechanism',
    dismissed: false,
    visible: true,
    wasVisible: true,
  });

  const resolved = await resolveBoundKeyboardRuntime({
    device: iosDevice,
    positionals: ['dismiss'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const result = await resolved.execute({});
  expect(result).toMatchObject({
    dismissed: false,
    mechanism: undefined,
    message: 'Keyboard already hidden',
  });
});

test('iOS dismiss omits a mechanism claim when the keyboard was never visible', async () => {
  const harness = runtimeHarness(iosDevice, 'apple', {
    status: unavailable,
    dismiss: available,
    enter: available,
  });
  harness.keyboardDismiss.mockResolvedValue({
    kind: 'mechanism',
    dismissed: false,
    visible: false,
    wasVisible: false,
  });

  const resolved = await resolveBoundKeyboardRuntime({
    device: iosDevice,
    positionals: ['dismiss'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const result = await resolved.execute({});
  expect(result).toMatchObject({
    wasVisible: false,
    mechanism: undefined,
    message: 'Keyboard already hidden',
  });
});

test('harmonyos dismiss reports success with no structured fields beyond the message', async () => {
  const harness = runtimeHarness(harmonyDevice, 'harmonyos', {
    status: unavailable,
    dismiss: available,
    enter: available,
  });
  harness.keyboardDismiss.mockResolvedValue({ kind: 'acknowledged' });

  const resolved = await resolveBoundKeyboardRuntime({
    device: harmonyDevice,
    positionals: ['dismiss'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(await resolved.execute({})).toEqual({
    platform: 'harmonyos',
    action: 'dismiss',
    message: 'Keyboard dismissed',
  });
});

test('android dismiss reports the full IME probe evidence', async () => {
  const harness = runtimeHarness(androidDevice, 'android', {
    status: available,
    dismiss: available,
    enter: available,
  });
  harness.keyboardDismiss.mockResolvedValue({
    kind: 'ime-probe',
    attempts: 2,
    wasVisible: true,
    dismissed: true,
    visible: false,
    inputType: 'text',
    type: 'ime',
    inputMethodPackage: 'com.google.android.inputmethod.latin',
    focusedPackage: 'com.example.app',
    focusedResourceId: 'com.example.app:id/field',
    inputOwner: 'app',
  });

  const resolved = await resolveBoundKeyboardRuntime({
    device: androidDevice,
    positionals: ['dismiss'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(await resolved.execute({})).toEqual({
    platform: 'android',
    action: 'dismiss',
    attempts: 2,
    wasVisible: true,
    dismissed: true,
    visible: false,
    inputType: 'text',
    type: 'ime',
    inputMethodPackage: 'com.google.android.inputmethod.latin',
    focusedPackage: 'com.example.app',
    focusedResourceId: 'com.example.app:id/field',
    inputOwner: 'app',
  });
});

test('iOS enter reports visibility evidence; android enter reports only success', async () => {
  const iosHarness = runtimeHarness(iosDevice, 'apple', {
    status: unavailable,
    dismiss: available,
    enter: available,
  });
  iosHarness.keyboardEnter.mockResolvedValue({
    kind: 'visibility-echo',
    visible: false,
    wasVisible: true,
  });
  const iosResolved = await resolveBoundKeyboardRuntime({
    device: iosDevice,
    positionals: ['enter'],
    inspectFacts: iosHarness.inspectFacts,
    bindDevice: iosHarness.bindDevice,
  });
  expect(iosResolved.ok).toBe(true);
  if (iosResolved.ok) {
    expect(await iosResolved.execute({})).toEqual({
      platform: 'ios',
      action: 'enter',
      visible: false,
      wasVisible: true,
      message: 'Keyboard enter pressed',
    });
  }

  const androidHarness = runtimeHarness(androidDevice, 'android', {
    status: available,
    dismiss: available,
    enter: available,
  });
  const androidResolved = await resolveBoundKeyboardRuntime({
    device: androidDevice,
    positionals: ['enter'],
    inspectFacts: androidHarness.inspectFacts,
    bindDevice: androidHarness.bindDevice,
  });
  expect(androidResolved.ok).toBe(true);
  if (androidResolved.ok) {
    expect(await androidResolved.execute({})).toEqual({
      platform: 'android',
      action: 'enter',
      message: 'Keyboard enter pressed',
    });
  }
});

test('harmonyos enter reports only success, distinctly from android despite an identical shape', async () => {
  const harness = runtimeHarness(harmonyDevice, 'harmonyos', {
    status: unavailable,
    dismiss: available,
    enter: available,
  });
  harness.keyboardEnter.mockResolvedValue({ kind: 'harmonyos-acknowledged' });

  const resolved = await resolveBoundKeyboardRuntime({
    device: harmonyDevice,
    positionals: ['enter'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(await resolved.execute({})).toEqual({
    platform: 'harmonyos',
    action: 'enter',
    message: 'Keyboard enter pressed',
  });
});

test('rejects an unknown subcommand before inspection or binding', async () => {
  const harness = runtimeHarness(androidDevice, 'android', {
    status: available,
    dismiss: available,
    enter: available,
  });

  await expect(
    resolveBoundKeyboardRuntime({
      device: androidDevice,
      positionals: ['sideways'],
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(harness.inspectFacts).not.toHaveBeenCalled();
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('rejects more than one subcommand argument', async () => {
  const harness = runtimeHarness(androidDevice, 'android', {
    status: available,
    dismiss: available,
    enter: available,
  });

  await expect(
    resolveBoundKeyboardRuntime({
      device: androidDevice,
      positionals: ['dismiss', 'extra'],
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
});

test('defaults to status with no positional', async () => {
  const harness = runtimeHarness(androidDevice, 'android', {
    status: available,
    dismiss: available,
    enter: available,
  });

  const resolved = await resolveBoundKeyboardRuntime({
    device: androidDevice,
    positionals: [],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  expect(harness.bindDevice).toHaveBeenCalledWith(androidDevice, keyboardStatusUse);
});
