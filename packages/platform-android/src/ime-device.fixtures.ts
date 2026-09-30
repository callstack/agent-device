import type { AndroidAdbExecutor, AndroidAdbExecutorResult } from './adb-transport.ts';

// An in-memory device speaking the exact shell surfaces the IME lifecycle touches: the
// `settings secure` namespace and `ime enable/disable/set`. Shared by the colocated IME module tests.

export type FakeImeDeviceState = {
  settings: Map<string, string>;
  imeSetFails?: boolean;
  /** Reading the selected IME fails, as `settings get` does when it times out under load. */
  inputMethodReadFails?: boolean;
  /** The IME Android selects when `ime disable` removes the selected one. */
  imeDisableFallback?: string;
  settingsWritesFail?: boolean;
};

const ok = (stdout = ''): AndroidAdbExecutorResult => ({ exitCode: 0, stdout, stderr: '' });

export function fakeImeDeviceAdb(state: FakeImeDeviceState): AndroidAdbExecutor {
  return async (args) => {
    if (args[1] === 'settings') return handleSettingsCall(state, args);
    if (args[1] === 'ime') return handleImeCall(state, args);
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };
}

function handleSettingsCall(
  state: FakeImeDeviceState,
  args: readonly string[],
): AndroidAdbExecutorResult {
  const [, , action, , key = '', value = ''] = args;
  if (action === 'get' && key === 'default_input_method' && state.inputMethodReadFails) {
    return { exitCode: 1, stdout: '', stderr: 'timed out' };
  }
  if (action === 'get') return ok(state.settings.get(key) ?? 'null');
  if (action === 'put') {
    if (state.settingsWritesFail) return { exitCode: 1, stdout: '', stderr: 'denied' };
    state.settings.set(key, value);
    return ok();
  }
  state.settings.delete(key);
  return ok();
}

function handleImeCall(
  state: FakeImeDeviceState,
  args: readonly string[],
): AndroidAdbExecutorResult {
  const [, , action, component = ''] = args;
  if (action === 'disable' && state.settings.get('default_input_method') === component) {
    if (state.imeDisableFallback)
      state.settings.set('default_input_method', state.imeDisableFallback);
    return ok();
  }
  if (action !== 'set') return ok();
  if (state.imeSetFails) return { exitCode: 1, stdout: '', stderr: 'ime set rejected' };
  state.settings.set('default_input_method', component);
  return ok();
}
