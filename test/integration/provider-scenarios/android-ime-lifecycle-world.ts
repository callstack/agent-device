type AndroidImeAdbResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type AndroidProviderShellState = {
  searchText: string;
  clipboardText: string;
  secureSettings: Map<string, string>;
  /** The last `settings put system user_rotation`; the scripted display reports it back. */
  userRotation: string;
};

const IME_INPUT_TEXT_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64';
const IME_CLEAR_TEXT_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT';
const IME_PACKAGE = 'com.callstack.agentdevice.imehelper';
const IME_PROTOCOL = 'android-ime-helper-v1';

export function androidImeInputTextBroadcast(text: string): string[] {
  return [
    'shell',
    'am',
    'broadcast',
    '-p',
    IME_PACKAGE,
    '-a',
    IME_INPUT_TEXT_ACTION,
    '--es',
    'protocol',
    IME_PROTOCOL,
    '--es',
    'text',
    Buffer.from(text, 'utf8').toString('base64'),
  ];
}

export const androidImeClearTextBroadcast = Object.freeze([
  'shell',
  'am',
  'broadcast',
  '-p',
  IME_PACKAGE,
  '-a',
  IME_CLEAR_TEXT_ACTION,
  '--es',
  'protocol',
  IME_PROTOCOL,
]);

export function createAndroidProviderShellState(): AndroidProviderShellState {
  return {
    searchText: '',
    clipboardText: 'hello',
    secureSettings: new Map([['default_input_method', 'com.android.inputmethod.latin/.LatinIME']]),
    userRotation: '0',
  };
}

/** Models the provider-side durable test-IME state used by lifecycle integration scenarios. */
export function androidImeLifecycleAdbResult(
  key: string,
  args: string[],
  state: AndroidProviderShellState | undefined,
): AndroidImeAdbResult | undefined {
  if (
    key === 'shell cmd package list packages --show-versioncode com.callstack.agentdevice.imehelper'
  ) {
    // A newer provider-installed helper takes the actual durable activation/recovery path without
    // adding an unrelated helper-installation fixture to each scenario.
    return {
      stdout: 'package:com.callstack.agentdevice.imehelper versionCode:999999\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (!state) return undefined;
  if (argsStartWith(args, ['shell', 'settings', 'get', 'secure']) && args[4]) {
    return {
      stdout: `${state.secureSettings.get(args[4]) ?? 'null'}\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  if (
    argsStartWith(args, ['shell', 'ime', 'enable']) ||
    argsStartWith(args, ['shell', 'ime', 'set'])
  ) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  return undefined;
}

/** Applies only durable IME-state mutations; the broader Android shell stays in android-world. */
export function updateAndroidProviderImeShellState(
  args: string[],
  state: AndroidProviderShellState,
): boolean {
  if (argsStartWith(args, ['shell', 'settings', 'put', 'secure']) && args[4] && args[5]) {
    state.secureSettings.set(args[4], args[5]);
    return true;
  }
  if (argsStartWith(args, ['shell', 'settings', 'delete', 'secure']) && args[4]) {
    state.secureSettings.delete(args[4]);
    return true;
  }
  if (argsStartWith(args, ['shell', 'ime', 'set']) && args[3]) {
    state.secureSettings.set('default_input_method', args[3]);
    return true;
  }
  if (argsStartWith(args, ['shell', 'am', 'broadcast']) && args.includes('-p')) {
    const action = valueAfter(args, '-a');
    if (action === IME_CLEAR_TEXT_ACTION) {
      state.searchText = '';
      return true;
    }
    if (action === IME_INPUT_TEXT_ACTION) {
      const encodedText = valueAfterPair(args, '--es', 'text');
      if (encodedText !== undefined)
        state.searchText += Buffer.from(encodedText, 'base64').toString('utf8');
      return true;
    }
  }
  return false;
}

function argsStartWith(args: string[], prefix: string[]): boolean {
  return prefix.every((value, index) => args[index] === value);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function valueAfterPair(args: string[], flag: string, key: string): string | undefined {
  for (let index = 0; index < args.length - 2; index += 1) {
    if (args[index] === flag && args[index + 1] === key) return args[index + 2];
  }
  return undefined;
}
