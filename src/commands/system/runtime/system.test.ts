import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  AgentDeviceBackend,
  BackendAlertAction,
  BackendAlertResult,
  BackendDeviceOrientation,
  BackendKeyboardOptions,
  BackendTvRemoteOptions,
} from '@agent-device/contracts/backend';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';

test('runtime system commands call typed backend primitives', async () => {
  const calls: unknown[] = [];
  const device = createAgentDevice({
    backend: createSystemBackend(calls),
    artifacts: createLocalArtifactAdapter(),
    policy: localCommandPolicy(),
  });

  const back = await device.system.back({ session: 'default', mode: 'system' });
  const home = await device.system.home({ session: 'default' });
  const rotated = await device.system.orientation({ orientation: 'landscape-left' });
  const keyboard = await device.system.keyboard({ action: 'dismiss' });
  const clipboardRead = await device.system.clipboard({ action: 'read' });
  const clipboardWrite = await device.system.clipboard({ action: 'write', text: 'hello' });
  const settings = await device.system.settings({ target: 'privacy' });
  const alert = await device.system.alert({ action: 'accept', timeoutMs: 500 });
  const appSwitcher = await device.system.appSwitcher();
  const tvRemote = await device.system.tvRemote({ button: 'select', durationMs: 300 });

  assert.equal(back.kind, 'systemBack');
  assert.equal(home.kind, 'systemHome');
  assert.equal(rotated.orientation, 'landscape-left');
  assert.equal(keyboard.kind, 'keyboardDismissed');
  assert.deepEqual(clipboardRead, { kind: 'clipboardText', action: 'read', text: 'copied' });
  assert.equal(clipboardWrite.kind, 'clipboardUpdated');
  assert.equal(clipboardWrite.textLength, 5);
  assert.equal(settings.target, 'privacy');
  assert.equal(alert.kind, 'alertHandled');
  assert.equal(appSwitcher.kind, 'appSwitcherOpened');
  assert.equal(tvRemote.kind, 'tvRemotePressed');
  assert.equal(tvRemote.button, 'select');
  assert.deepEqual(calls, [
    { command: 'pressBack', mode: 'system', session: 'default' },
    { command: 'pressHome', session: 'default' },
    { command: 'setOrientation', orientation: 'landscape-left' },
    { command: 'setKeyboard', options: { action: 'dismiss' } },
    { command: 'getClipboard' },
    { command: 'setClipboard', text: 'hello' },
    { command: 'openSettings', target: 'privacy' },
    { command: 'handleAlert', action: 'accept', timeoutMs: 500 },
    { command: 'openAppSwitcher' },
    { command: 'pressTvRemote', options: { button: 'select', durationMs: 300 } },
  ]);
});

// #1598: the SDK-level keyboard.dismiss result must also disclose which
// mechanism the backend used, mirroring the CLI/daemon dispatch surface.
test('runtime keyboard dismiss discloses the mechanism reported by the backend', async () => {
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      setKeyboard: async (_context, options) => ({
        action: options.action,
        dismissed: true,
        visible: false,
        mechanism: 'legacySafeAreaTap',
      }),
    },
    artifacts: createLocalArtifactAdapter(),
    policy: localCommandPolicy(),
  });

  const keyboard = await device.system.keyboard({ action: 'dismiss' });

  assert.equal(keyboard.kind, 'keyboardDismissed');
  if (keyboard.kind === 'keyboardDismissed') {
    assert.equal(keyboard.state.mechanism, 'legacySafeAreaTap');
  }
  assert.equal(String(keyboard.message), 'Keyboard dismissed');
});

test('runtime system commands validate options before backend calls', async () => {
  const calls: unknown[] = [];
  const device = createAgentDevice({
    backend: createSystemBackend(calls),
    artifacts: createLocalArtifactAdapter(),
    policy: localCommandPolicy(),
  });

  await assert.rejects(
    () => device.system.orientation({ orientation: 'sideways' as BackendDeviceOrientation }),
    /orientation must be/,
  );
  await assert.rejects(
    () => device.system.keyboard({ action: 'hide' as BackendKeyboardOptions['action'] }),
    /action must be/,
  );
  await assert.rejects(
    () => device.system.clipboard({ action: 'write', text: undefined as unknown as string }),
    /requires text/,
  );
  await assert.rejects(
    () => device.system.alert({ action: 'tap' as BackendAlertAction }),
    /action must be/,
  );
  await assert.rejects(
    () => device.system.tvRemote({ button: 'blue' as BackendTvRemoteOptions['button'] }),
    /button must be/,
  );

  assert.deepEqual(calls, []);
});

test('runtime alert wait projects the backend alert, timing, and timeout verdict', async () => {
  const alert = { title: 'Location', message: 'Allow access?', buttons: ['Allow', 'Deny'] };
  const outcomes: BackendAlertResult[] = [
    { kind: 'alertWait', alert, waitedMs: 250 },
    { kind: 'alertWait', alert: null, waitedMs: 5_000, timedOut: true },
    { kind: 'alertWait', alert },
  ];
  let next = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      handleAlert: async (): Promise<BackendAlertResult> => {
        const result = outcomes[next++];
        if (!result) throw new Error('alert backend double exhausted');
        return result;
      },
    },
    artifacts: createLocalArtifactAdapter(),
    policy: localCommandPolicy(),
  });

  const visible = await device.system.alert({ action: 'wait', timeoutMs: 1_000 });
  if (visible.kind !== 'alertWait') throw new Error(`expected alertWait, got ${visible.kind}`);
  assert.deepEqual(visible.alert, alert);
  assert.equal(visible.waitedMs, 250);
  assert.equal(visible.timedOut, undefined);
  assert.equal(String(visible.message), 'Alert visible');

  const timedOut = await device.system.alert({ action: 'wait', timeoutMs: 5_000 });
  if (timedOut.kind !== 'alertWait') throw new Error(`expected alertWait, got ${timedOut.kind}`);
  assert.equal(timedOut.alert, null);
  assert.equal(timedOut.waitedMs, 5_000);
  assert.equal(timedOut.timedOut, true);
  assert.equal(String(timedOut.message), 'Alert wait timed out');

  // A backend that reports neither timing field keeps both keys absent.
  const bare = await device.system.alert({ action: 'wait' });
  if (bare.kind !== 'alertWait') throw new Error(`expected alertWait, got ${bare.kind}`);
  assert.deepEqual(bare.alert, alert);
  assert.equal('waitedMs' in bare, false);
  assert.equal('timedOut' in bare, false);
  assert.equal(String(bare.message), 'Alert visible');
});

test('runtime alert wait refuses a backend result of the wrong kind', async () => {
  // Typed as the union the backend contract allows: a wrong `kind` is a legal
  // backend result the normalizer must refuse with the typed COMMAND_FAILED
  // code, not just the message.
  const wrongKind: BackendAlertResult = { kind: 'alertStatus', alert: null };
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      handleAlert: async () => wrongKind,
    },
    artifacts: createLocalArtifactAdapter(),
    policy: localCommandPolicy(),
  });

  await assert.rejects(
    () => device.system.alert({ action: 'wait' }),
    (error: unknown) => {
      const appError = error as { code?: string; message?: string };
      assert.equal(appError.code, 'COMMAND_FAILED');
      assert.match(appError.message ?? '', /system\.alert wait returned an invalid backend result/);
      return true;
    },
  );
});

function createSystemBackend(calls: unknown[]): AgentDeviceBackend {
  return {
    platform: 'ios',
    pressBack: async (context, options) => {
      calls.push({ command: 'pressBack', mode: options?.mode, session: context.session });
      return { ok: true };
    },
    pressHome: async (context) => {
      calls.push({ command: 'pressHome', session: context.session });
    },
    setOrientation: async (_context, orientation) => {
      calls.push({ command: 'setOrientation', orientation });
    },
    setKeyboard: async (_context, options) => {
      calls.push({ command: 'setKeyboard', options });
      return { action: options.action, dismissed: true, visible: false };
    },
    getClipboard: async () => {
      calls.push({ command: 'getClipboard' });
      return { text: 'copied' };
    },
    setClipboard: async (_context, text) => {
      calls.push({ command: 'setClipboard', text });
    },
    openSettings: async (_context, target) => {
      calls.push({ command: 'openSettings', target });
    },
    handleAlert: async (_context, action, options) => {
      calls.push({ command: 'handleAlert', action, timeoutMs: options?.timeoutMs });
      return { kind: 'alertHandled', handled: true, button: 'OK' };
    },
    openAppSwitcher: async () => {
      calls.push({ command: 'openAppSwitcher' });
    },
    pressTvRemote: async (_context, options) => {
      calls.push({ command: 'pressTvRemote', options });
    },
  };
}
