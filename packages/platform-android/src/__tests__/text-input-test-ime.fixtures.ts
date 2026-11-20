// Shared fakes for the test-IME text-entry tests: the packaged helper artifact they route through,
// the broadcast acknowledgement the v2 receiver answers with, and the field content each broadcast
// leaves behind. Both files that exercise the channel read the same fake, so an ack and the field it
// wrote mean the same thing in all of them.

export const PACKAGE = 'com.callstack.agentdevice.imehelper';

export const CLEAR_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT';
export const INPUT_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64';

/**
 * The artifact both the bundled resolver and the provider-aware selector answer with, so the tests
 * never read android/ime-helper/dist from disk (a fresh checkout that has not packaged the helper
 * has none — CI's Coverage job included).
 */
export function androidImeHelperFixtureArtifact() {
  return {
    apkPath: '/fixture/helper.apk',
    manifest: {
      name: 'android-ime-helper' as const,
      version: '0.0.0',
      assetName: 'helper.apk',
      sha256: 'a'.repeat(64),
      packageName: PACKAGE,
      versionCode: 1,
      serviceComponent: 'com.callstack.agentdevice.imehelper/.TestInputMethodService',
      broadcastProtocol: 'android-ime-helper-v2' as const,
    },
  };
}

/**
 * Acknowledges text and clear with the attempted UTF-16 length and updates the fixture's field.
 */
export function imeBroadcastAck(
  args: readonly string[],
  state: { currentText: string },
): { exitCode: number; stdout: string; stderr: string } {
  const action = args[args.indexOf('-a') + 1];
  if (action === CLEAR_ACTION) {
    state.currentText = '';
    return { exitCode: 0, stdout: 'Broadcast completed: result=1, data="utf16=0"\n', stderr: '' };
  }
  if (action === INPUT_ACTION) {
    const text = decodeBroadcastText(args);
    state.currentText += text;
    return {
      exitCode: 0,
      stdout: `Broadcast completed: result=1, data="utf16=${text.length}"\n`,
      stderr: '',
    };
  }
  return { exitCode: 0, stdout: 'Broadcast completed: result=0\n', stderr: '' };
}

export function dispatchBroadcasts(
  calls: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  return calls.filter((args) => args[1] === 'am' && args[2] === 'broadcast');
}

export function decodeBroadcastText(args: readonly string[] | undefined): string {
  const textIndex = args?.indexOf('text') ?? -1;
  if (!args || textIndex < 0) return '';
  return Buffer.from(args[textIndex + 1] ?? '', 'base64').toString('utf8');
}

/** Settings reads after a rebind: its device record reads back, and the helper is still selected. */
export function helperSelected(args: readonly string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const stdout =
    args[4] === 'agent_device_ime_helper_rebind_displaced'
      ? '1\n'
      : 'com.callstack.agentdevice.imehelper/.TestInputMethodService\n';
  return { exitCode: 0, stdout, stderr: '' };
}

export function helperImeInputMethodDump(): string {
  return [
    'mInputShown=true',
    `mCurMethodId=${PACKAGE}/.TestInputMethodService`,
    'packageName=com.example.shop',
    'resourceId=com.example.shop:id/search',
    'inputType=0x1',
  ].join('\n');
}

export function androidInputXml(options: { text: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="${options.text}" focused="true" bounds="[0,0][200,100]"/></hierarchy>`;
}
