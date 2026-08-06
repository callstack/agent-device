import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AndroidAdbExecutor } from '../adb-executor.ts';
import { AppError } from '@agent-device/kernel/errors';
import { promises as fs } from 'node:fs';
import {
  dismissAndroidKeyboard,
  getAndroidKeyboardState,
  getAndroidKeyboardStatusWithAdb,
  writeAndroidClipboardWithAdb,
} from '../device-input-state.ts';
import { flushDiagnosticsToSessionFile, withDiagnosticsScope } from '../../../utils/diagnostics.ts';
import { assertRejectsAppError, withFakeAdb } from '../../../__tests__/test-utils/index.ts';
import { mkdtempForTest } from '../../../__tests__/test-utils/tmp-dir.ts';

// The fake adb provider installs through the production withAndroidAdbProvider
// scope, so `calls` records device-scoped args without a leading `-s <serial>`.

test('getAndroidKeyboardStatusWithAdb exposes active input method package', async () => {
  const adb: AndroidAdbExecutor = async (args) => {
    assert.deepEqual(args, ['shell', 'dumpsys', 'input_method']);
    return {
      stdout:
        'mInputShown=true mCurMethodId=com.google.android.inputmethod.latin/.LatinIME inputType=0x1',
      stderr: '',
      exitCode: 0,
    };
  };

  await assert.doesNotReject(async () => {
    const state = await getAndroidKeyboardStatusWithAdb(adb);
    assert.deepEqual(state, {
      visible: true,
      inputType: '0x1',
      type: 'text',
      inputMethodPackage: 'com.google.android.inputmethod.latin',
      focusedPackage: undefined,
      focusedResourceId: undefined,
      inputOwner: 'unknown',
    });
  });
});

test('getAndroidKeyboardStatusWithAdb classifies tolerated adb failures with actionable hints', async () => {
  // allowFailure regression: the executor returns the nonzero result instead of
  // throwing, so the classified hint must come from the result-to-error path.
  const adb: AndroidAdbExecutor = async () => ({
    stdout: '',
    stderr: 'error: device offline',
    exitCode: 1,
  });

  const error = await getAndroidKeyboardStatusWithAdb(adb).then(
    () => assert.fail('expected the keyboard query to reject'),
    (err: unknown) => err,
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.adbFailure, 'device_offline');
  assert.equal(error.details?.retriable, true);
  assert.match(String(error.details?.hint), /adb reconnect/i);
});

test('getAndroidKeyboardState reads visibility and input type', async () => {
  await withFakeAdb(
    (args) =>
      args.join(' ') === 'shell dumpsys input_method'
        ? [
            'mInputShown=true mIsInputViewShown=true',
            'inputType=0x21 imeOptions=0x12000000 privateImeOptions=null',
          ].join('\n')
        : { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 },
    async ({ device }) => {
      const state = await getAndroidKeyboardState(device);
      assert.equal(state.visible, true);
      assert.equal(state.inputType, '0x21');
      assert.equal(state.type, 'email');
    },
  );
});

test('getAndroidKeyboardState reports active IME ownership from dumpsys', async () => {
  await withFakeAdb(
    (args) =>
      args.join(' ') === 'shell dumpsys input_method'
        ? [
            'mInputShown=true mIsInputViewShown=true',
            'mCurMethodId=com.samsung.android.honeyboard/.service.HoneyBoardService',
            'mCurAttribute=EditorInfo{packageName=com.samsung.android.honeyboard inputType=0x1 resourceId=com.samsung.android.honeyboard:id/handwriting}',
          ].join('\n')
        : { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 },
    async ({ device }) => {
      const state = await getAndroidKeyboardState(device);
      assert.equal(state.visible, true);
      assert.equal(state.inputType, '0x1');
      assert.equal(state.inputMethodPackage, 'com.samsung.android.honeyboard');
      assert.equal(state.focusedPackage, 'com.samsung.android.honeyboard');
      assert.equal(state.focusedResourceId, 'com.samsung.android.honeyboard:id/handwriting');
      assert.equal(state.inputOwner, 'ime');
    },
  );
});

test('getAndroidKeyboardState diagnoses fallback IME ownership classification', async () => {
  await withFakeAdb(
    (args) =>
      args.join(' ') === 'shell dumpsys input_method'
        ? [
            'mInputShown=true mIsInputViewShown=true',
            'mCurAttribute=EditorInfo{packageName=com.google.android.inputmethod.latin inputType=0x1 resourceId=com.google.android.inputmethod.latin:id/handwriting}',
          ].join('\n')
        : { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 },
    async ({ device }) => {
      const homeDir = await mkdtempForTest('agent-device-diagnostics-home-');
      const previousHome = process.env.HOME;
      let diagnosticsPath: string | null = null;
      try {
        process.env.HOME = homeDir;
        const state = await withDiagnosticsScope({ session: 'keyboard-ime-fallback' }, async () => {
          const keyboardState = await getAndroidKeyboardState(device);
          diagnosticsPath = flushDiagnosticsToSessionFile({ force: true });
          return keyboardState;
        });

        assert.equal(state.inputOwner, 'ime');
        assert.ok(diagnosticsPath);
        const diagnostics = await fs.readFile(diagnosticsPath, 'utf8');
        assert.match(diagnostics, /android_input_ownership_fallback/);
        assert.match(diagnostics, /com\.google\.android\.inputmethod\.latin/);
      } finally {
        process.env.HOME = previousHome;
      }
    },
  );
});

test('getAndroidKeyboardState does not treat inputmethod substring as IME ownership', async () => {
  await withFakeAdb(
    (args) =>
      args.join(' ') === 'shell dumpsys input_method'
        ? [
            'mInputShown=true mIsInputViewShown=true',
            'mCurAttribute=EditorInfo{packageName=com.example.inputmethodnotes inputType=0x1 resourceId=com.example.inputmethodnotes:id/editor}',
          ].join('\n')
        : { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 },
    async ({ device }) => {
      const state = await getAndroidKeyboardState(device);
      assert.equal(state.focusedPackage, 'com.example.inputmethodnotes');
      assert.equal(state.inputOwner, 'app');
    },
  );
});

test('getAndroidKeyboardState falls back to mImeWindowVis flag', async () => {
  await withFakeAdb(
    (args) =>
      args.join(' ') === 'shell dumpsys input_method'
        ? ['mImeWindowVis=0x1', 'inputType=0x2'].join('\n')
        : { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 },
    async ({ device }) => {
      const state = await getAndroidKeyboardState(device);
      assert.equal(state.visible, true);
      assert.equal(state.inputType, '0x2');
      assert.equal(state.type, 'number');
    },
  );
});

test('getAndroidKeyboardState uses latest visibility value when dumpsys contains duplicates', async () => {
  await withFakeAdb(
    (args) =>
      args.join(' ') === 'shell dumpsys input_method'
        ? [
            'mInputShown=true',
            'mInputShown=false',
            'mIsInputViewShown=false',
            'inputType=0x21',
          ].join('\n')
        : { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 },
    async ({ device }) => {
      const state = await getAndroidKeyboardState(device);
      assert.equal(state.visible, false);
      assert.equal(state.inputType, '0x21');
      assert.equal(state.type, 'email');
    },
  );
});

test('getAndroidKeyboardState treats stale input view as hidden when the IME window is hidden', async () => {
  await withFakeAdb(
    (args) =>
      args.join(' ') === 'shell dumpsys input_method'
        ? [
            'mInputShown=false',
            'mDecorViewVisible=false mWindowVisible=false mInShowWindow=false',
            'mIsInputViewShown=true',
            'inputType=0x21',
          ].join('\n')
        : { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 },
    async ({ device }) => {
      const state = await getAndroidKeyboardState(device);
      assert.equal(state.visible, false);
      assert.equal(state.inputType, '0x21');
      assert.equal(state.type, 'email');
    },
  );
});

test('writeAndroidClipboardWithAdb shell-quotes text containing metacharacters', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  await writeAndroidClipboardWithAdb(adb, 'otp; echo pwned');

  assert.deepEqual(calls, [['shell', 'cmd', 'clipboard', 'set', 'text', "'otp; echo pwned'"]]);
});

test('writeAndroidClipboardWithAdb leaves safe text unquoted', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  await writeAndroidClipboardWithAdb(adb, 'android-otp');

  assert.deepEqual(calls, [['shell', 'cmd', 'clipboard', 'set', 'text', 'android-otp']]);
});

test('dismissAndroidKeyboard skips keyevent when keyboard is already hidden', async () => {
  await withFakeAdb(
    (args) => {
      const flat = args.join(' ');
      if (flat === 'shell dumpsys input_method') {
        return 'mInputShown=false mIsInputViewShown=false';
      }
      if (flat === 'shell input keyevent 111') {
        return { stderr: 'unexpected keyevent', exitCode: 1 };
      }
      return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      const result = await dismissAndroidKeyboard(device);
      assert.equal(result.attempts, 0);
      assert.equal(result.wasVisible, false);
      assert.equal(result.dismissed, false);
      assert.equal(result.visible, false);

      const keyevents = calls.filter((args) => args.join(' ') === 'shell input keyevent 111');
      assert.deepEqual(keyevents, []);
    },
  );
});

test('dismissAndroidKeyboard sends escape keyevent and confirms hidden state', async () => {
  let keyboardHidden = false;
  await withFakeAdb(
    (args) => {
      const flat = args.join(' ');
      if (flat === 'shell dumpsys input_method') {
        // Terminal state immediately after the keyevent: the re-poll observes
        // the dismissed keyboard on its first check.
        return keyboardHidden
          ? 'mInputShown=false mIsInputViewShown=false'
          : ['mInputShown=true mIsInputViewShown=true', 'inputType=0x2'].join('\n');
      }
      if (flat === 'shell input keyevent 111') {
        keyboardHidden = true;
        return '';
      }
      return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      const result = await dismissAndroidKeyboard(device);
      assert.equal(result.attempts, 1);
      assert.equal(result.wasVisible, true);
      assert.equal(result.dismissed, true);
      assert.equal(result.visible, false);

      const flat = calls.map((args) => args.join(' '));
      assert.ok(flat.includes('shell dumpsys input_method'), flat.join('; '));
      assert.ok(flat.includes('shell input keyevent 111'), flat.join('; '));
    },
  );
});

test('dismissAndroidKeyboard fails explicitly when non-navigation dismiss does not hide the keyboard', async () => {
  await withFakeAdb(
    (args) => {
      const flat = args.join(' ');
      if (flat === 'shell dumpsys input_method') {
        return ['mInputShown=true mIsInputViewShown=true', 'inputType=0x1'].join('\n');
      }
      if (flat === 'shell input keyevent 111') return '';
      return { stderr: `unexpected args: ${flat}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      await assertRejectsAppError(() => dismissAndroidKeyboard(device), {
        code: 'UNSUPPORTED_OPERATION',
        message: /without back navigation/i,
      });

      const flat = calls.map((args) => args.join(' '));
      assert.ok(flat.includes('shell input keyevent 111'), flat.join('; '));
      assert.equal(
        flat.some((call) => call === 'shell input keyevent 4'),
        false,
        flat.join('; '),
      );
    },
  );
});
