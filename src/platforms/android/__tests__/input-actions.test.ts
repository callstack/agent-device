import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fillAndroid,
  rotateAndroid,
  scrollAndroid,
  swipeAndroid,
  typeAndroid,
} from '../input-actions.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { withScriptedAdb } from '../../../__tests__/test-utils/mocked-binaries.ts';

test('scrollAndroid supports explicit pixel travel distance', async () => {
  await withScriptedAdb(
    'agent-device-android-scroll-pixels-',
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "wm" ] && [ "$3" = "size" ]; then',
      '  echo "Physical size: 1080x1920"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      const result = await scrollAndroid(device, 'down', { pixels: 240, durationMs: 120 });
      const args = await fs.readFile(argsLogPath, 'utf8');

      assert.match(args, /shell\ninput\nswipe\n540\n1080\n540\n840\n120\n/);
      assert.doesNotMatch(args, /uiautomator|dump/);
      assert.equal(result.pixels, 240);
      assert.equal(result.durationMs, 120);
      assert.equal(result.referenceWidth, 1080);
      assert.equal(result.referenceHeight, 1920);
    },
  );
});

test('rotateAndroid locks auto-rotate and sets user rotation', async () => {
  await withScriptedAdb(
    'agent-device-android-rotate-landscape-left-',
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await rotateAndroid(device, 'landscape-left');
      const lines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      const logged = lines.join(' ');
      assert.match(logged, /shell settings put system accelerometer_rotation 0/);
      assert.match(logged, /shell settings put system user_rotation 1/);
    },
  );
});

test('swipeAndroid invokes adb input swipe with duration', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-swipe-test-'));
  const adbPath = path.join(tmpDir, 'adb');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    adbPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  try {
    await swipeAndroid(device, 10, 20, 30, 40, 250);
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, [
      '-s',
      'emulator-5554',
      'shell',
      'input',
      'swipe',
      '10',
      '20',
      '30',
      '40',
      '250',
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('typeAndroid chunks ASCII input text for shell fallback', async () => {
  await withScriptedAdb(
    'agent-device-android-type-ascii-chunked-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await typeAndroid(device, 'filed the expense');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\ninput\ntext\nfiled%sth/);
      assert.match(logged, /shell\ninput\ntext\ne%sexpens/);
      assert.match(logged, /shell\ninput\ntext\ne/);
      const shellInputTextCount = (logged.match(/shell\ninput\ntext\n/g) ?? []).length;
      assert.equal(shellInputTextCount, 3);
    },
  );
});

test('typeAndroid passes shell-sensitive ascii text to adb input text', async () => {
  await withScriptedAdb(
    'agent-device-android-type-ascii-special-',
    '#!/bin/sh\nprintf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await typeAndroid(device, 'curtis.layne+test+73kmc@uber.com');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\ninput\ntext\ncurtis\.l/);
      assert.match(logged, /shell\ninput\ntext\nayne\+tes/);
      assert.match(logged, /shell\ninput\ntext\nt\+73kmc@/);
      assert.match(logged, /shell\ninput\ntext\nuber\.com/);
    },
  );
});

test('typeAndroid preserves percent signs while encoding spaces', async () => {
  await withScriptedAdb(
    'agent-device-android-type-ascii-percent-',
    '#!/bin/sh\nprintf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await typeAndroid(device, '50% complete');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\ninput\ntext\n50%%scomp/);
      assert.match(logged, /shell\ninput\ntext\nlete/);
    },
  );
});

test('typeAndroid sends one character at a time when delay is requested', async () => {
  await withScriptedAdb(
    'agent-device-android-type-delayed-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await typeAndroid(device, 'hey', 1);
      const logged = await fs.readFile(argsLogPath, 'utf8');
      const shellInputTextCount = (logged.match(/shell\ninput\ntext\n/g) ?? []).length;
      assert.equal(shellInputTextCount, 3);
      assert.match(logged, /shell\ninput\ntext\nh/);
      assert.match(logged, /shell\ninput\ntext\ne/);
      assert.match(logged, /shell\ninput\ntext\ny/);
    },
  );
});

test('fillAndroid uses chunk-safe shell input and retries when verification still fails', async () => {
  await withScriptedAdb(
    'agent-device-android-fill-fallback-',
    [
      '#!/bin/sh',
      'STATE_FILE="$(dirname "$AGENT_DEVICE_TEST_ARGS_FILE")/fill_state.txt"',
      'INPUT_COUNT_FILE="$(dirname "$AGENT_DEVICE_TEST_ARGS_FILE")/input_count.txt"',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      ...androidSnapshotHelperStateFileScript(),
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "tap" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "keyevent" ] && [ "$4" = "KEYCODE_MOVE_END" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "keyevent" ] && [ "$4" = "KEYCODE_DEL" ]; then',
      '  : > "$STATE_FILE"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "text" ]; then',
      '  count="$(cat "$INPUT_COUNT_FILE" 2>/dev/null || echo 0)"',
      '  count=$((count + 1))',
      '  printf "%s" "$count" > "$INPUT_COUNT_FILE"',
      '  if [ "$count" -eq 1 ]; then',
      '    printf "curti" > "$STATE_FILE"',
      '  else',
      '    printf "%s" "$4" >> "$STATE_FILE"',
      '  fi',
      '  exit 0',
      'fi',
      'if [ "$1" = "exec-out" ] && [ "$2" = "uiautomator" ] && [ "$3" = "dump" ] && [ "$4" = "/dev/tty" ]; then',
      '  text="$(cat "$STATE_FILE" 2>/dev/null)"',
      '  printf "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?><hierarchy><node class=\\"android.widget.EditText\\" text=\\"%s\\" focused=\\"true\\" bounds=\\"[0,0][200,100]\\"/></hierarchy>" "$text"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await fillAndroid(device, 10, 10, 'curtis.layne+test+73kmc@uber.com');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.doesNotMatch(logged, /shell\ncmd\nclipboard\nset\ntext/);
      assert.doesNotMatch(logged, /shell\ninput\nkeyevent\nKEYCODE_PASTE/);
      const shellInputTextCount = (logged.match(/shell\ninput\ntext\n/g) ?? []).length;
      assert.ok(shellInputTextCount > 1);
    },
  );
}, 15_000);

test('fillAndroid keeps delayed typing in typed-input mode', async () => {
  await withScriptedAdb(
    'agent-device-android-fill-delayed-',
    [
      '#!/bin/sh',
      'STATE_FILE="$(dirname "$AGENT_DEVICE_TEST_ARGS_FILE")/fill_state.txt"',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      ...androidSnapshotHelperStateFileScript(),
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "tap" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "keyevent" ] && [ "$4" = "KEYCODE_MOVE_END" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "keyevent" ] && [ "$4" = "KEYCODE_DEL" ]; then',
      '  : > "$STATE_FILE"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "text" ]; then',
      '  printf "%s" "$4" >> "$STATE_FILE"',
      '  exit 0',
      'fi',
      'if [ "$1" = "exec-out" ] && [ "$2" = "uiautomator" ] && [ "$3" = "dump" ] && [ "$4" = "/dev/tty" ]; then',
      '  text="$(cat "$STATE_FILE" 2>/dev/null)"',
      '  printf "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?><hierarchy><node class=\\"android.widget.EditText\\" text=\\"%s\\" focused=\\"true\\" bounds=\\"[0,0][200,100]\\"/></hierarchy>" "$text"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await fillAndroid(device, 10, 10, 'go', 1);
      const logged = await fs.readFile(argsLogPath, 'utf8');
      const shellInputTextCount = (logged.match(/shell\ninput\ntext\n/g) ?? []).length;
      assert.equal(shellInputTextCount, 2);
      assert.doesNotMatch(logged, /shell\ncmd\nclipboard\nset\ntext/);
      assert.doesNotMatch(logged, /shell\ninput\nkeyevent\nKEYCODE_PASTE/);
    },
  );
}, 15_000);

test('fillAndroid tolerates delayed React Native text verification', async () => {
  await withScriptedAdb(
    'agent-device-android-fill-delayed-verify-',
    [
      '#!/bin/sh',
      'STATE_FILE="$(dirname "$AGENT_DEVICE_TEST_ARGS_FILE")/fill_state.txt"',
      'DUMP_COUNT_FILE="$(dirname "$AGENT_DEVICE_TEST_ARGS_FILE")/dump_count.txt"',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "tap" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "keyevent" ] && [ "$4" = "KEYCODE_MOVE_END" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "keyevent" ] && [ "$4" = "KEYCODE_DEL" ]; then',
      '  : > "$STATE_FILE"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "text" ]; then',
      '  text="$(printf "%s" "$4" | sed "s/%s/ /g")"',
      '  printf "%s" "$text" >> "$STATE_FILE"',
      '  exit 0',
      'fi',
      'if [ "$1" = "exec-out" ] && [ "$2" = "uiautomator" ] && [ "$3" = "dump" ] && [ "$4" = "/dev/tty" ]; then',
      '  count="$(cat "$DUMP_COUNT_FILE" 2>/dev/null || echo 0)"',
      '  count=$((count + 1))',
      '  printf "%s" "$count" > "$DUMP_COUNT_FILE"',
      '  if [ "$count" -eq 1 ]; then',
      '    text="sent the updat"',
      '  else',
      '    text="$(cat "$STATE_FILE" 2>/dev/null)"',
      '  fi',
      '  printf "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?><hierarchy><node class=\\"android.widget.EditText\\" text=\\"%s\\" focused=\\"true\\" bounds=\\"[0,0][200,100]\\"/></hierarchy>" "$text"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ device }) => {
      await fillAndroid(device, 10, 10, 'sent the update');
    },
  );
}, 10_000);

test('typeAndroid reports clear error when unicode input is unsupported', async () => {
  await withScriptedAdb(
    'agent-device-android-type-unicode-unsupported-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "cmd" ] && [ "$3" = "clipboard" ] && [ "$4" = "set" ] && [ "$5" = "text" ]; then',
      '  echo "No shell command implementation."',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "input" ] && [ "$3" = "text" ]; then',
      '  echo "Exception occurred while executing \'text\':" >&2',
      '  echo "java.lang.NullPointerException" >&2',
      '  exit 255',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ device }) => {
      await assert.rejects(
        () => typeAndroid(device, '很'),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'COMMAND_FAILED');
          assert.match((error as AppError).message, /provider-native text injection/i);
          return true;
        },
      );
    },
  );
});

function androidSnapshotHelperStateFileScript(): string[] {
  return [
    'if [ "$1" = "shell" ] && [ "$2" = "cmd" ] && [ "$3" = "package" ] && [ "$4" = "list" ] && [ "$5" = "packages" ] && [ "$6" = "--show-versioncode" ] && [ "$7" = "com.callstack.agentdevice.snapshothelper" ]; then',
    '  printf "package:com.callstack.agentdevice.snapshothelper versionCode:999999\\n"',
    '  exit 0',
    'fi',
    'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "instrument" ]; then',
    '  text="$(cat "$STATE_FILE" 2>/dev/null)"',
    '  xml="$(printf "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?><hierarchy><node class=\\"android.widget.EditText\\" text=\\"%s\\" focused=\\"true\\" bounds=\\"[0,0][200,100]\\"/></hierarchy>" "$text")"',
    '  payload="$(printf "%s" "$xml" | base64 | tr -d "\\n")"',
    '  printf "INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1\\n"',
    '  printf "INSTRUMENTATION_STATUS: helperApiVersion=1\\n"',
    '  printf "INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml\\n"',
    '  printf "INSTRUMENTATION_STATUS: chunkIndex=0\\n"',
    '  printf "INSTRUMENTATION_STATUS: chunkCount=1\\n"',
    '  printf "INSTRUMENTATION_STATUS: payloadBase64=%s\\n" "$payload"',
    '  printf "INSTRUMENTATION_STATUS_CODE: 1\\n"',
    '  printf "INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1\\n"',
    '  printf "INSTRUMENTATION_RESULT: helperApiVersion=1\\n"',
    '  printf "INSTRUMENTATION_RESULT: ok=true\\n"',
    '  printf "INSTRUMENTATION_CODE: 0\\n"',
    '  exit 0',
    'fi',
  ];
}
