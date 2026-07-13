import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import {
  fillAndroid,
  longPressAndroid,
  scrollAndroid,
  setAndroidOrientation,
  typeAndroid,
} from '../input-actions.ts';
import { AppError } from '../../../kernel/errors.ts';
import { withScriptedAdb } from '../../../__tests__/test-utils/mocked-binaries.ts';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/index.ts';
import { withAndroidAdbProvider, type AndroidTouchInjector } from '../adb-executor.ts';

test('scrollAndroid plans explicit pixel travel through semantic touch injection', async () => {
  const touchCalls: Parameters<AndroidTouchInjector>[0][] = [];
  const result = await withAndroidAdbProvider(
    {
      exec: async () => {
        throw new Error('adb must not run');
      },
      gestureViewport: async () => ({ x: 10, y: 20, width: 1080, height: 1920 }),
      touch: async (request) => {
        touchCalls.push(request);
        return { injected: true };
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () => await scrollAndroid(ANDROID_EMULATOR, 'down', { pixels: 240, durationMs: 120 }),
  );

  assert.equal(touchCalls.length, 1);
  const touch = touchCalls[0]!;
  assert.equal(touch.intent, 'pan');
  assert.deepEqual(touch.pointers[0]?.samples[0]?.point, { x: 550, y: 1100 });
  assert.deepEqual(touch.pointers[0]?.samples.at(-1)?.point, { x: 550, y: 860 });
  assert.equal(result.pixels, 240);
  assert.equal(result.durationMs, 120);
  assert.equal(result.referenceWidth, 1090);
  assert.equal(result.referenceHeight, 1940);
  assert.equal(result.x1, 550);
  assert.equal(result.y1, 1100);
  assert.equal(result.x2, 550);
  assert.equal(result.y2, 860);
  assert.equal(result.backend, 'provider-native-touch');
  assert.equal(result.injected, true);
});

test('scrollAndroid accepts sub-frame public durations at the Android planner minimum', async () => {
  const touchCalls: Parameters<AndroidTouchInjector>[0][] = [];
  const results = await withAndroidAdbProvider(
    {
      exec: async () => {
        throw new Error('adb must not run');
      },
      gestureViewport: async () => ({ x: 0, y: 0, width: 1080, height: 1920 }),
      touch: async (request) => {
        touchCalls.push(request);
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      const outputs: Record<string, unknown>[] = [];
      for (const durationMs of [0, 15]) {
        outputs.push(await scrollAndroid(ANDROID_EMULATOR, 'down', { durationMs }));
      }
      return outputs;
    },
  );

  assert.deepEqual(
    touchCalls.map((call) => call.durationMs),
    [16, 16],
  );
  assert.deepEqual(
    results.map((result) => result.durationMs),
    [16, 16],
  );
});

test('longPressAndroid sends a stationary semantic touch plan', async () => {
  const touchCalls: Parameters<AndroidTouchInjector>[0][] = [];
  const result = await withAndroidAdbProvider(
    {
      exec: async () => {
        throw new Error('adb must not run');
      },
      gestureViewport: async () => ({ x: 10, y: 20, width: 300, height: 500 }),
      touch: async (request) => {
        touchCalls.push(request);
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () => await longPressAndroid(ANDROID_EMULATOR, 30, 40, 750),
  );

  assert.deepEqual(touchCalls, [
    {
      topology: 'single',
      intent: 'longPress',
      durationMs: 750,
      viewport: { x: 10, y: 20, width: 300, height: 500 },
      pointers: [
        {
          pointerId: 0,
          samples: [
            { offsetMs: 0, point: { x: 30, y: 40 } },
            { offsetMs: 750, point: { x: 30, y: 40 } },
          ],
        },
      ],
    },
  ]);
  assert.equal(result.backend, 'provider-native-touch');
});

test('setAndroidOrientation locks auto-rotate and sets user rotation', async () => {
  await withScriptedAdb(
    'agent-device-android-rotate-landscape-left-',
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await setAndroidOrientation(device, 'landscape-left');
      const lines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      const logged = lines.join(' ');
      assert.match(logged, /shell settings put system accelerometer_rotation 0/);
      assert.match(logged, /shell settings put system user_rotation 1/);
    },
  );
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
