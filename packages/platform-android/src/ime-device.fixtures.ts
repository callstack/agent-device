import type { AndroidAdbExecutor, AndroidAdbExecutorResult } from './adb-transport.ts';

// An in-memory device speaking the exact shell surfaces the IME lifecycle touches: the
// `settings secure` namespace and `ime enable/set`. Shared by the colocated IME module tests.

export type FakeImeDeviceState = {
  settings: Map<string, string>;
  imeSetFails?: boolean;
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

function handleSettingsCall(state: FakeImeDeviceState, args: string[]): AndroidAdbExecutorResult {
  const [, , action, , key = '', value = ''] = args;
  if (action === 'get') return ok(state.settings.get(key) ?? 'null');
  if (action === 'put') {
    if (state.settingsWritesFail) return { exitCode: 1, stdout: '', stderr: 'denied' };
    state.settings.set(key, value);
    return ok();
  }
  state.settings.delete(key);
  return ok();
}

function handleImeCall(state: FakeImeDeviceState, args: string[]): AndroidAdbExecutorResult {
  const [, , action, component = ''] = args;
  if (action !== 'set') return ok();
  if (state.imeSetFails) return { exitCode: 1, stdout: '', stderr: 'ime set rejected' };
  state.settings.set('default_input_method', component);
  return ok();
}
