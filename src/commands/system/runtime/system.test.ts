import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  AgentDeviceBackend,
  BackendAlertAction,
  BackendDeviceOrientation,
  BackendKeyboardOptions,
  BackendTvRemoteOptions,
} from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice, localCommandPolicy } from '../../../runtime.ts';

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
