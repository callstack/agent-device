import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AndroidAdbExecutor } from '../adb-executor.ts';
import { AppError } from '../../../kernel/errors.ts';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dismissAndroidKeyboard,
  getAndroidKeyboardState,
  getAndroidKeyboardStatusWithAdb,
} from '../device-input-state.ts';
import { flushDiagnosticsToSessionFile, withDiagnosticsScope } from '../../../utils/diagnostics.ts';
import { withScriptedAdb } from '../../../__tests__/test-utils/mocked-binaries.ts';

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
  await withScriptedAdb(
    'agent-device-android-keyboard-state-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "dumpsys" ] && [ "$3" = "input_method" ]; then',
      '  echo "mInputShown=true mIsInputViewShown=true"',
      '  echo "inputType=0x21 imeOptions=0x12000000 privateImeOptions=null"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ device }) => {
      const state = await getAndroidKeyboardState(device);
      assert.equal(state.visible, true);
      assert.equal(state.inputType, '0x21');
      assert.equal(state.type, 'email');
    },
  );
});

test('getAndroidKeyboardState reports active IME ownership from dumpsys', async () => {
  await withScriptedAdb(
    'agent-device-android-keyboard-ime-owner-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "dumpsys" ] && [ "$3" = "input_method" ]; then',
      '  echo "mInputShown=true mIsInputViewShown=true"',
      '  echo "mCurMethodId=com.samsung.android.honeyboard/.service.HoneyBoardService"',
      '  echo "mCurAttribute=EditorInfo{packageName=com.samsung.android.honeyboard inputType=0x1 resourceId=com.samsung.android.honeyboard:id/handwriting}"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
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
  await withScriptedAdb(
    'agent-device-android-keyboard-ime-fallback-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "dumpsys" ] && [ "$3" = "input_method" ]; then',
      '  echo "mInputShown=true mIsInputViewShown=true"',
      '  echo "mCurAttribute=EditorInfo{packageName=com.google.android.inputmethod.latin inputType=0x1 resourceId=com.google.android.inputmethod.latin:id/handwriting}"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ device }) => {
      const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-diagnostics-home-'));
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
  await withScriptedAdb(
    'agent-device-android-keyboard-inputmethod-substring-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "dumpsys" ] && [ "$3" = "input_method" ]; then',
      '  echo "mInputShown=true mIsInputViewShown=true"',
      '  echo "mCurAttribute=EditorInfo{packageName=com.example.inputmethodnotes inputType=0x1 resourceId=com.example.inputmethodnotes:id/editor}"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ device }) => {
      const state = await getAndroidKeyboardState(device);
      assert.equal(state.focusedPackage, 'com.example.inputmethodnotes');
      assert.equal(state.inputOwner, 'app');
    },
  );
});

test('getAndroidKeyboardState falls back to mImeWindowVis flag', async () => {
  await withScriptedAdb(
    'agent-device-android-keyboard-window-vis-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "dumpsys" ] && [ "$3" = "input_method" ]; then',
      '  echo "mImeWindowVis=0x1"',
      '  echo "inputType=0x2"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ device }) => {
      const state = await getAndroidKeyboardState(device);
      assert.equal(state.visible, true);
      assert.equal(state.inputType, '0x2');
      assert.equal(state.type, 'number');
    },
  );
});

test('getAndroidKeyboardState uses latest visibility value when dumpsys contains duplicates', async () => {
  await withScriptedAdb(
    'agent-device-android-keyboard-duplicate-visibility-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "dumpsys" ] && [ "$3" = "input_method" ]; then',
      '  echo "mInputShown=true"',
      '  echo "mInputShown=false"',
      '  echo "mIsInputViewShown=false"',
      '  echo "inputType=0x21"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ device }) => {
      const state = await getAndroidKeyboardState(device);
      assert.equal(state.visible, false);
      assert.equal(state.inputType, '0x21');
      assert.equal(state.type, 'email');
    },
  );
});

test('getAndroidKeyboardState treats stale input view as hidden when the IME window is hidden', async () => {
  await withScriptedAdb(
    'agent-device-android-keyboard-stale-input-view-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "dumpsys" ] && [ "$3" = "input_method" ]; then',
      '  echo "mInputShown=false"',
      '  echo "mDecorViewVisible=false mWindowVisible=false mInShowWindow=false"',
      '  echo "mIsInputViewShown=true"',
      '  echo "inputType=0x21"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ device }) => {
      const state = await getAndroidKeyboardState(device);
      assert.equal(state.visible, false);
      assert.equal(state.inputType, '0x21');
      assert.equal(state.type, 'email');
    },
  );
});

test('dismissAndroidKeyboard skips keyevent when keyboard is already hidden', async () => {
  await withScriptedAdb(
    'agent-device-android-keyboard-dismiss-hidden-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "dumpsys" ] && [ "$3" = "input_method" ]; then',
      '  echo "mInputShown=false mIsInputViewShown=false"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "keyevent" ] && [ "$4" = "111" ]; then',
      '  echo "unexpected keyevent" >&2',
      '  exit 1',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      const result = await dismissAndroidKeyboard(device);
      assert.equal(result.attempts, 0);
      assert.equal(result.wasVisible, false);
      assert.equal(result.dismissed, false);
      assert.equal(result.visible, false);

      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.doesNotMatch(logged, /shell\ninput\nkeyevent\n111/);
    },
  );
});

test('dismissAndroidKeyboard sends escape keyevent and confirms hidden state', async () => {
  await withScriptedAdb(
    'agent-device-android-keyboard-dismiss-visible-',
    [
      '#!/bin/sh',
      'STATE_FILE="$(dirname "$AGENT_DEVICE_TEST_ARGS_FILE")/keyboard_hidden.txt"',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "dumpsys" ] && [ "$3" = "input_method" ]; then',
      '  if [ -f "$STATE_FILE" ]; then',
      '    echo "mInputShown=false mIsInputViewShown=false"',
      '    exit 0',
      '  fi',
      '  echo "mInputShown=true mIsInputViewShown=true"',
      '  echo "inputType=0x2"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "keyevent" ] && [ "$4" = "111" ]; then',
      '  touch "$STATE_FILE"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      const result = await dismissAndroidKeyboard(device);
      assert.equal(result.attempts, 1);
      assert.equal(result.wasVisible, true);
      assert.equal(result.dismissed, true);
      assert.equal(result.visible, false);

      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\ndumpsys\ninput_method/);
      assert.match(logged, /shell\ninput\nkeyevent\n111/);
    },
  );
});

test('dismissAndroidKeyboard fails explicitly when non-navigation dismiss does not hide the keyboard', async () => {
  await withScriptedAdb(
    'agent-device-android-keyboard-dismiss-unsupported-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "dumpsys" ] && [ "$3" = "input_method" ]; then',
      '  echo "mInputShown=true mIsInputViewShown=true"',
      '  echo "inputType=0x1"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "keyevent" ] && [ "$4" = "111" ]; then',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await assert.rejects(
        dismissAndroidKeyboard(device),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'UNSUPPORTED_OPERATION' &&
          /without back navigation/i.test(error.message),
      );

      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\ninput\nkeyevent\n111/);
      assert.doesNotMatch(logged, /shell\ninput\nkeyevent\n4/);
    },
  );
});
