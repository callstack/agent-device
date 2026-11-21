import type { AndroidAdbExecutor, AndroidAdbExecutorResult } from './adb-transport.ts';
import { flushRecordKey, type AndroidAdbHostStub } from './adb-host.fixtures.ts';
import { registerTestImeRestore } from './ime-state.ts';

// An in-memory device speaking the exact shell surfaces the IME lifecycle touches: the
// `settings secure` namespace and `ime enable/disable/set`. Shared by the colocated IME module tests.

// Registers a restore through the production registrar, then ages its flush record by ageMs.
// A `writer` other than this process stands in for a daemon that has since exited.
// Default provenance is confirmed: a registered window normally comes from a confirmed
// restore, and wait-derivation tests read only the deadline; tests pinning marker-clear
// eligibility pass provenance explicitly. Lives here so a record-SHAPE change lands in one edit.
export async function seedRestoreRecord(
  host: AndroidAdbHostStub,
  serial: string,
  ageMs: number,
  options: Readonly<{ confirmed?: boolean; stateDir?: string; writer?: string }> = {},
): Promise<void> {
  const stateDir = options.stateDir ?? '/state';
  await registerTestImeRestore(stateDir, serial, options.confirmed ?? true);
  const key = flushRecordKey(stateDir, serial);
  const record = host.flushRecordStore.get(key);
  if (!record) throw new Error('registrar wrote no flush record');
  host.flushRecordStore.set(key, {
    ...record,
    deadlineMs: record.deadlineMs - ageMs,
    writer: options.writer ?? record.writer,
  });
}

export function flushRecordSerials(host: AndroidAdbHostStub, stateDir = '/state'): string[] {
  const prefix = flushRecordKey(stateDir, '');
  return [...host.flushRecordStore.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

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
