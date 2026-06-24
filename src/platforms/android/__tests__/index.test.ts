import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeAndroidApp,
  inferAndroidAppName,
  installAndroidApp,
  installAndroidInstallablePath,
  openAndroidApp,
  parseAndroidLaunchComponent,
  resolveAndroidApp,
} from '../app-lifecycle.ts';
import { dismissAndroidKeyboard, getAndroidKeyboardState } from '../device-input-state.ts';
import {
  fillAndroid,
  rotateAndroid,
  scrollAndroid,
  swipeAndroid,
  typeAndroid,
} from '../input-actions.ts';
import { pushAndroidNotification } from '../notifications.ts';
import { setAndroidSetting } from '../settings.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import { parseAndroidLaunchablePackages } from '../app-parsers.ts';
import type { DeviceInfo } from '../../../utils/device.ts';
import { flushDiagnosticsToSessionFile, withDiagnosticsScope } from '../../../utils/diagnostics.ts';
import { AppError } from '../../../utils/errors.ts';
import { androidUiNodes, parseUiHierarchy } from '../ui-hierarchy.ts';

async function withMockedAdb(
  tempPrefix: string,
  script: string,
  run: (ctx: { argsLogPath: string; device: DeviceInfo }) => Promise<void>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix));
  const adbPath = path.join(tmpDir, 'adb');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(adbPath, script, 'utf8');
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
    await run({ argsLogPath, device });
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('parseUiHierarchy does not truncate when no max node count is requested', () => {
  const xml = [
    '<hierarchy>',
    ...Array.from(
      { length: 900 },
      (_, index) =>
        `<node text="Item ${index}" class="android.widget.TextView" enabled="true" bounds="[0,${index}][100,${index + 1}]" />`,
    ),
    '</hierarchy>',
  ].join('');

  const result = parseUiHierarchy(xml, undefined, { raw: true });

  assert.equal(result.nodes.length, 900);
  assert.equal(result.truncated, undefined);
});

function androidOpenAdbScript(): string {
  return [
    '#!/bin/sh',
    'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
    'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
    'if [ "$1" = "-s" ]; then',
    '  shift',
    '  shift',
    'fi',
    'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "start" ]; then',
    '  echo "Status: ok"',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

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

test('parseUiHierarchy reads double-quoted Android node attributes', () => {
  const xml =
    '<hierarchy><node class="android.widget.TextView" text="Hello" content-desc="Greeting" resource-id="com.demo:id/title" bounds="[10,20][110,60]" clickable="true" enabled="true"/></hierarchy>';

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.value, 'Hello');
  assert.equal(result.nodes[0]!.label, 'Hello');
  assert.equal(result.nodes[0]!.identifier, 'com.demo:id/title');
  assert.deepEqual(result.nodes[0]!.rect, { x: 10, y: 20, width: 100, height: 40 });
  assert.equal(result.nodes[0]!.hittable, true);
  assert.equal(result.nodes[0]!.enabled, true);
  assert.equal(result.nodes[0]!.visibleToUser, undefined);
});

test('parseUiHierarchy reads single-quoted Android node attributes', () => {
  const xml =
    "<hierarchy><node class='android.widget.TextView' text='Hello' content-desc='Greeting' resource-id='com.demo:id/title' bounds='[10,20][110,60]' clickable='true' enabled='true'/></hierarchy>";

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.value, 'Hello');
  assert.equal(result.nodes[0]!.label, 'Hello');
  assert.equal(result.nodes[0]!.identifier, 'com.demo:id/title');
  assert.deepEqual(result.nodes[0]!.rect, { x: 10, y: 20, width: 100, height: 40 });
  assert.equal(result.nodes[0]!.hittable, true);
  assert.equal(result.nodes[0]!.enabled, true);
});

test('parseUiHierarchy supports mixed quote styles in one node', () => {
  const xml =
    '<hierarchy><node class="android.widget.TextView" text=\'Hello\' content-desc="Greeting" resource-id=\'com.demo:id/title\' bounds="[10,20][110,60]"/></hierarchy>';

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.value, 'Hello');
  assert.equal(result.nodes[0]!.label, 'Hello');
  assert.equal(result.nodes[0]!.identifier, 'com.demo:id/title');
});

test('parseUiHierarchy decodes XML entities in Android node attributes', () => {
  const xml =
    '<hierarchy><node class="android.widget.TextView" text="Line 1&#10;Line 2&#9;&amp;&lt;&gt;&quot;&apos;" bounds="[0,0][10,10]"/></hierarchy>';

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.value, 'Line 1\nLine 2\t&<>"\'');
  assert.equal(result.nodes[0]!.label, 'Line 1\nLine 2\t&<>"\'');
});

test('parseUiHierarchy keeps visible Android nodes with meaningful test identifiers', () => {
  const xml = `<hierarchy>
  <node class="android.widget.ScrollView" package="com.example.app" bounds="[0,0][1080,1886]" clickable="true" visible-to-user="true">
    <node class="android.view.ViewGroup" package="com.example.app" resource-id="album-0" bounds="[0,0][540,540]" visible-to-user="true"/>
    <node class="android.widget.ImageView" package="com.example.app" bounds="[0,0][540,540]" visible-to-user="true"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, {});

  assert.equal(
    result.nodes.some((node) => node.identifier === 'album-0'),
    true,
  );
});

test('parseUiHierarchy reads Android bounds with negative coordinates', () => {
  const xml =
    '<hierarchy><node class="android.widget.TextView" text="Clipped" bounds="[0,935][-67,994]"/></hierarchy>';

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.deepEqual(result.nodes[0]!.rect, { x: 0, y: 935, width: 0, height: 59 });
});

test('androidUiNodes exposes decoded Android hierarchy metadata', () => {
  const xml =
    '<hierarchy><node package="com.example.app" class="android.widget.EditText" text="Fish &amp; Chips" content-desc="Search&#10;field" resource-id="com.example.app:id/search" bounds="[10,20][110,70]" clickable="false" enabled="true" visible-to-user="true" drawing-order="4" focusable="true" focused="true" password="true" window-index="0" window-type="1" window-layer="3" window-active="true" window-focused="false" window-bounds="[0,0][390,844]"/></hierarchy>';

  assert.deepEqual(Array.from(androidUiNodes(xml)), [
    {
      text: 'Fish & Chips',
      desc: 'Search\nfield',
      resourceId: 'com.example.app:id/search',
      packageName: 'com.example.app',
      className: 'android.widget.EditText',
      bounds: '[10,20][110,70]',
      rect: { x: 10, y: 20, width: 100, height: 50 },
      clickable: false,
      enabled: true,
      visibleToUser: true,
      drawingOrder: 4,
      focusable: true,
      focused: true,
      password: true,
      windowIndex: 0,
      windowType: 1,
      windowLayer: 3,
      windowActive: true,
      windowFocused: false,
      windowRect: { x: 0, y: 0, width: 390, height: 844 },
    },
  ]);
});

test('parseUiHierarchy discards stale inactive Android application windows', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][390,844]" window-index="0" window-type="1" window-layer="10" window-active="true" window-focused="true" window-bounds="[0,0][390,844]">
    <node class="android.widget.TextView" text="Foreground article" bounds="[10,20][200,60]" enabled="true"/>
  </node>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][300,844]" window-index="1" window-type="1" window-layer="9" window-active="false" window-focused="false" window-bounds="[0,0][300,844]">
    <node class="android.widget.TextView" text="Stale drawer item" bounds="[10,20][200,60]" enabled="true"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Foreground article'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Stale drawer item'),
    false,
  );
});

test('parseUiHierarchy keeps the active Android application overlay window', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][390,844]" window-index="0" window-type="1" window-layer="9" window-active="false" window-focused="false" window-bounds="[0,0][390,844]">
    <node class="android.widget.TextView" text="Covered content" bounds="[10,20][200,60]" enabled="true"/>
  </node>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][300,844]" window-index="1" window-type="1" window-layer="10" window-active="true" window-focused="true" window-bounds="[0,0][300,844]">
    <node class="android.widget.TextView" text="Foreground drawer item" bounds="[10,20][200,60]" enabled="true"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Covered content'),
    false,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Foreground drawer item'),
    true,
  );
});

test('parseUiHierarchy keeps only the top active Android application window', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][390,844]" window-index="0" window-type="1" window-layer="9" window-active="true" window-focused="false" window-bounds="[0,0][390,844]">
    <node class="android.widget.TextView" text="Active stale content" bounds="[10,20][200,60]" enabled="true"/>
  </node>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][390,844]" window-index="1" window-type="1" window-layer="10" window-active="true" window-focused="true" window-bounds="[0,0][390,844]">
    <node class="android.widget.TextView" text="Top active content" bounds="[10,20][200,60]" enabled="true"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Active stale content'),
    false,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Top active content'),
    true,
  );
});

test('parseUiHierarchy excludes Android nodes that are not visible to the user', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">
    <node class="android.widget.Button" text="Visible action" bounds="[10,20][200,60]" clickable="true" enabled="true" visible-to-user="true"/>
    <node class="android.widget.Button" text="Hidden drawer action" bounds="[10,80][200,120]" clickable="true" enabled="true" visible-to-user="false"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { interactiveOnly: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Visible action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Hidden drawer action'),
    false,
  );
});

test('parseUiHierarchy prunes Android nodes that are not visible to the user in raw snapshots', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">
    <node class="android.widget.Button" text="Hidden drawer action" bounds="[10,80][200,120]" clickable="true" enabled="true" visible-to-user="false"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes[0]!.visibleToUser, true);
  assert.equal(
    result.nodes.some((node) => node.label === 'Hidden drawer action'),
    false,
  );
});

test('parseUiHierarchy prunes descendants of Android nodes that are not visible to the user', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" enabled="true" visible-to-user="false">
      <node class="android.widget.Button" text="Hidden drawer action" bounds="[10,80][200,120]" clickable="true" enabled="true" visible-to-user="true"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Hidden drawer action'),
    false,
  );
});

test('parseUiHierarchy prunes lower drawing-order subtrees covered by a foreground sibling', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" text="Foreground action" bounds="[24,420][366,480]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.ScrollView" bounds="[0,120][300,844]" scrollable="true" clickable="true" enabled="true" visible-to-user="true" drawing-order="1">
        <node class="android.widget.Button" text="Hidden drawer action" bounds="[0,220][280,280]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Foreground action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Hidden drawer action'),
    false,
  );
});

test('parseUiHierarchy keeps visible side-by-side drawer and content subtrees', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][120,844]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" text="Visible drawer action" bounds="[0,220][110,280]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[120,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="Visible content action" bounds="[150,420][366,480]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Visible drawer action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Visible content action'),
    true,
  );
});

test('parseUiHierarchy keeps lower siblings when drawing-order metadata is unavailable', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true">
      <node class="android.widget.Button" text="Foreground action" bounds="[24,420][366,480]" clickable="true" enabled="true" visible-to-user="true"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true">
      <node class="android.widget.Button" text="Legacy drawer action" bounds="[0,220][280,280]" clickable="true" enabled="true" visible-to-user="true"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Foreground action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Legacy drawer action'),
    true,
  );
});

test('parseUiHierarchy keeps overlapping siblings when drawing-order ties', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="First tied action" bounds="[24,420][366,480]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="Second tied action" bounds="[0,220][280,280]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'First tied action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Second tied action'),
    true,
  );
});

test('parseUiHierarchy keeps lower siblings below the covered-area threshold', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,717]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" text="Partial overlay action" bounds="[24,420][366,480]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="Mostly visible action" bounds="[0,760][280,820]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Partial overlay action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Mostly visible action'),
    true,
  );
});

test('parseUiHierarchy keeps lower siblings covered only by non-agent-visible overlays', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="2"/>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="Still visible action" bounds="[0,220][280,280]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Still visible action'),
    true,
  );
});

test('parseUiHierarchy ignores attribute-name prefix spoofing', () => {
  const xml =
    "<hierarchy><node class='android.widget.TextView' hint-text='Spoofed' text='Actual' bounds='[10,20][110,60]'/></hierarchy>";

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.value, 'Actual');
});

test('scrollAndroid supports explicit pixel travel distance', async () => {
  await withMockedAdb(
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
      const result = await scrollAndroid(device, 'down', { pixels: 240 });
      const args = await fs.readFile(argsLogPath, 'utf8');

      assert.match(args, /shell\ninput\nswipe\n540\n1080\n540\n840\n300\n/);
      assert.doesNotMatch(args, /uiautomator|dump/);
      assert.equal(result.pixels, 240);
      assert.equal(result.referenceWidth, 1080);
      assert.equal(result.referenceHeight, 1920);
    },
  );
});

test('parseAndroidLaunchComponent extracts final resolved component', () => {
  const stdout = [
    'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true',
    'com.boatsgroup.boattrader/com.boatsgroup.boattrader.MainActivity',
  ].join('\n');
  assert.equal(
    parseAndroidLaunchComponent(stdout),
    'com.boatsgroup.boattrader/com.boatsgroup.boattrader.MainActivity',
  );
});

test('parseAndroidLaunchComponent returns null when no component is present', () => {
  const stdout = 'No activity found';
  assert.equal(parseAndroidLaunchComponent(stdout), null);
});

test('inferAndroidAppName derives readable names from package ids', () => {
  assert.equal(inferAndroidAppName('com.android.settings'), 'Settings');
  assert.equal(inferAndroidAppName('com.google.android.apps.maps'), 'Maps');
  assert.equal(inferAndroidAppName('org.mozilla.firefox'), 'Firefox');
  assert.equal(inferAndroidAppName('com.facebook.katana'), 'Katana');
  assert.equal(inferAndroidAppName('single'), 'Single');
  assert.equal(inferAndroidAppName('com.android.app.services'), 'Services');
});

test('parseAndroidLaunchablePackages ignores cmd package query metadata lines', () => {
  assert.deepEqual(
    parseAndroidLaunchablePackages(
      [
        '25',
        'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true',
        'com.google.android.apps.maps/.MainActivity',
        'service-without-component',
        'org.mozilla.firefox/.App',
      ].join('\n'),
    ),
    ['com.google.android.apps.maps', 'org.mozilla.firefox'],
  );
});

test('installAndroidApp installs .apk via adb install -r', async () => {
  const apkPath = path.join(os.tmpdir(), `agent-device-test-${Date.now()}.apk`);
  await fs.writeFile(apkPath, 'placeholder', 'utf8');
  await withMockedAdb(
    'agent-device-android-install-apk-',
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await installAndroidApp(device, apkPath);
      const logged = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').join(' ');
      assert.match(logged, /install -r .*agent-device-test-.*\.apk/);
    },
  );
  await fs.rm(apkPath, { force: true });
});

test('installAndroidInstallablePath uses provider install capability when available', async () => {
  const apkPath = path.join(os.tmpdir(), `agent-device-provider-install-${Date.now()}.apk`);
  await fs.writeFile(apkPath, 'placeholder', 'utf8');
  const installCalls: Array<{ source: string; replace: boolean | undefined }> = [];
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  try {
    await withAndroidAdbProvider(
      {
        exec: async (args) => {
          throw new Error(`unexpected adb exec: ${args.join(' ')}`);
        },
        install: async (source, options) => {
          installCalls.push({ source: String(source), replace: options?.replace });
          return { stdout: 'Success', stderr: '', exitCode: 0 };
        },
      },
      { serial: 'emulator-5554' },
      async () => await installAndroidInstallablePath(device, apkPath),
    );
  } finally {
    await fs.rm(apkPath, { force: true });
  }

  assert.deepEqual(installCalls, [{ source: apkPath, replace: true }]);
});

test('installAndroidApp resolves packageName and launchTarget from nested archive artifacts', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-android-install-archive-'));
  const adbPath = path.join(tmpDir, 'adb');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const installMarkerPath = path.join(tmpDir, 'installed.marker');
  const archivePath = path.join(tmpDir, 'Sample.zip');
  const manifestDir = path.join(tmpDir, 'manifest');
  const nestedDir = path.join(tmpDir, 'nested');
  await fs.mkdir(manifestDir);
  await fs.mkdir(nestedDir);
  await fs.writeFile(
    path.join(manifestDir, 'AndroidManifest.xml'),
    '<manifest package="com.example.archive" />',
    'utf8',
  );
  execFileSync('zip', ['-qr', path.join(nestedDir, 'Sample.apk'), 'AndroidManifest.xml'], {
    cwd: manifestDir,
  });
  execFileSync('zip', ['-qr', archivePath, 'nested'], { cwd: tmpDir });

  await fs.writeFile(
    adbPath,
    [
      '#!/bin/sh',
      'printf "adb %s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ] && [ "$4" = "packages" ]; then',
      `  if [ -f "${installMarkerPath}" ]; then`,
      '    echo "package:com.example.archive"',
      '  fi',
      '  exit 0',
      'fi',
      'if [ "$1" = "install" ] && [ "$2" = "-r" ]; then',
      `  : > "${installMarkerPath}"`,
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
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
    const result = await installAndroidApp(device, archivePath);
    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.equal(result.archivePath, archivePath);
    assert.equal(result.packageName, 'com.example.archive');
    assert.equal(result.appName, 'Archive');
    assert.equal(result.launchTarget, 'com.example.archive');
    assert.equal(result.installablePath.endsWith('/nested/Sample.apk'), true);
    assert.match(logged, /adb -s emulator-5554 install -r .*nested\/Sample\.apk/);
    assert.doesNotMatch(logged, /adb -s emulator-5554 shell pm list packages/);
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

test('installAndroidApp installs .aab via bundletool build-apks + install-apks', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-android-install-aab-'));
  const adbPath = path.join(tmpDir, 'adb');
  const bundletoolPath = path.join(tmpDir, 'bundletool');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const aabPath = path.join(tmpDir, 'Sample.aab');
  await fs.writeFile(aabPath, 'placeholder', 'utf8');
  await fs.writeFile(
    adbPath,
    '#!/bin/sh\nprintf "adb %s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(adbPath, 0o755);
  await fs.writeFile(
    bundletoolPath,
    [
      '#!/bin/sh',
      'printf "bundletool %s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "build-apks" ]; then',
      '  out=""',
      '  while [ "$#" -gt 0 ]; do',
      '    if [ "$1" = "--output" ]; then',
      '      out="$2"',
      '      shift 2',
      '      continue',
      '    fi',
      '    shift',
      '  done',
      '  # PATH is narrowed to the fake tools dir; test output paths are absolute.',
      '  /bin/mkdir -p "${out%/*}"',
      '  printf "apks" > "$out"',
      '  exit 0',
      'fi',
      'if [ "$1" = "install-apks" ]; then',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(bundletoolPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  const previousBundletoolJar = process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
  process.env.PATH = tmpDir;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;
  delete process.env.AGENT_DEVICE_BUNDLETOOL_JAR;

  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  try {
    await installAndroidApp(device, aabPath);
    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.match(logged, /bundletool build-apks .*--bundle .*Sample\.aab .*--mode universal/);
    assert.match(logged, /bundletool install-apks .*--device-id emulator-5554/);
    assert.doesNotMatch(logged, /adb .* install -r/);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    if (previousBundletoolJar === undefined) {
      delete process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
    } else {
      process.env.AGENT_DEVICE_BUNDLETOOL_JAR = previousBundletoolJar;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('installAndroidApp .aab reports missing bundletool tooling', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-android-install-aab-missing-tool-'),
  );
  const adbPath = path.join(tmpDir, 'adb');
  const aabPath = path.join(tmpDir, 'Sample.aab');
  await fs.writeFile(aabPath, 'placeholder', 'utf8');
  await fs.writeFile(adbPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousBundletoolJar = process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
  process.env.PATH = tmpDir;
  delete process.env.AGENT_DEVICE_BUNDLETOOL_JAR;

  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  try {
    await assert.rejects(
      () => installAndroidApp(device, aabPath),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'TOOL_MISSING');
        assert.match((error as AppError).message, /bundletool/i);
        return true;
      },
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousBundletoolJar === undefined) {
      delete process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
    } else {
      process.env.AGENT_DEVICE_BUNDLETOOL_JAR = previousBundletoolJar;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('installAndroidApp .aab rejects relative AGENT_DEVICE_BUNDLETOOL_JAR overrides', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-android-install-aab-relative-jar-'),
  );
  const adbPath = path.join(tmpDir, 'adb');
  const aabPath = path.join(tmpDir, 'Sample.aab');
  await fs.writeFile(aabPath, 'placeholder', 'utf8');
  await fs.writeFile(adbPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousBundletoolJar = process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
  process.env.PATH = tmpDir;
  process.env.AGENT_DEVICE_BUNDLETOOL_JAR = './bundletool-all.jar';

  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  try {
    await assert.rejects(() => installAndroidApp(device, aabPath), { code: 'INVALID_ARGS' });
  } finally {
    process.env.PATH = previousPath;
    if (previousBundletoolJar === undefined) {
      delete process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
    } else {
      process.env.AGENT_DEVICE_BUNDLETOOL_JAR = previousBundletoolJar;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('openAndroidApp rejects activity override for deep link URLs', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  await assert.rejects(
    () => openAndroidApp(device, '  https://example.com/path  ', '.MainActivity'),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      return true;
    },
  );
});

test('closeAndroidApp waits until package is no longer foreground', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: string[][] = [];
  let focusPolls = 0;

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        if (args.join(' ') === 'shell dumpsys window windows') {
          focusPolls += 1;
          return {
            stdout:
              focusPolls === 1
                ? 'mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}\n'
                : 'mCurrentFocus=Window{43 u0 com.android.launcher/.Launcher}\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async () => {},
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await closeAndroidApp(device, 'com.example.app'),
  );

  assert.deepEqual(calls, [
    ['shell', 'am', 'force-stop', 'com.example.app'],
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
  ]);
});

test('closeAndroidApp returns after force-stop when package is already not foreground', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: string[][] = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        if (args.join(' ') === 'shell dumpsys window windows') {
          return {
            stdout: 'mCurrentFocus=Window{43 u0 com.android.launcher/.Launcher}\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async () => {},
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await closeAndroidApp(device, 'com.example.app'),
  );

  assert.deepEqual(calls, [
    ['shell', 'am', 'force-stop', 'com.example.app'],
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
  ]);
});

test('closeAndroidApp waits until package process exits after force-stop', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: string[][] = [];
  let processPolls = 0;

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        if (args.join(' ') === 'shell dumpsys window windows') {
          return {
            stdout: 'mCurrentFocus=Window{43 u0 com.android.launcher/.Launcher}\n',
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.join(' ') === 'shell pidof com.example.app') {
          processPolls += 1;
          return {
            stdout: processPolls === 1 ? '12345\n' : '',
            stderr: '',
            exitCode: processPolls === 1 ? 0 : 1,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async () => {},
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await closeAndroidApp(device, 'com.example.app'),
  );

  assert.deepEqual(calls, [
    ['shell', 'am', 'force-stop', 'com.example.app'],
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
    ['shell', 'pidof', 'com.example.app'],
  ]);
});

test('openAndroidApp ensures Android reverse before localhost deep link launch', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: Array<
    { kind: 'exec'; args: string[] } | { kind: 'reverse'; local: string; remote: string }
  > = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push({ kind: 'exec', args });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async (mapping) => {
          calls.push({ kind: 'reverse', local: mapping.local, remote: mapping.remote });
        },
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await openAndroidApp(device, 'exp://127.0.0.1:8083'),
  );

  assert.deepEqual(calls, [
    { kind: 'reverse', local: 'tcp:8083', remote: 'tcp:8083' },
    {
      kind: 'exec',
      args: [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'exp://127.0.0.1:8083',
      ],
    },
  ]);
});

test('openAndroidApp ensures Android reverse before IPv6 localhost deep link launch', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: Array<
    { kind: 'exec'; args: string[] } | { kind: 'reverse'; local: string; remote: string }
  > = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push({ kind: 'exec', args });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async (mapping) => {
          calls.push({ kind: 'reverse', local: mapping.local, remote: mapping.remote });
        },
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await openAndroidApp(device, 'http://[::1]:8081/status'),
  );

  assert.deepEqual(calls, [
    { kind: 'reverse', local: 'tcp:8081', remote: 'tcp:8081' },
    {
      kind: 'exec',
      args: [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'http://[::1]:8081/status',
      ],
    },
  ]);
});

test('openAndroidApp leaves localhost deep links without a port unchanged', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: string[][] = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async () => {
          throw new Error('reverse should not run without a URL port');
        },
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await openAndroidApp(device, 'http://localhost/path'),
  );

  assert.deepEqual(calls, [
    [
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'http://localhost/path',
    ],
  ]);
});

test('openAndroidApp leaves non-localhost deep links unchanged', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const calls: string[][] = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      reverse: {
        ensure: async () => {
          throw new Error('reverse should not run for remote URLs');
        },
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => await openAndroidApp(device, 'https://example.com:8083/path'),
  );

  assert.deepEqual(calls, [
    [
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'https://example.com:8083/path',
    ],
  ]);
});

test('openAndroidApp reports localhost reverse failures with port context', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        throw new Error(`unexpected adb exec: ${args.join(' ')}`);
      },
      reverse: {
        ensure: async () => {
          throw new Error('bridge unavailable');
        },
        remove: async () => {},
        removeAllOwned: async () => {},
      },
    },
    { serial: 'emulator-5554' },
    async () => {
      await assert.rejects(
        () => openAndroidApp(device, 'http://localhost:8081'),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'COMMAND_FAILED');
          assert.match((error as Error).message, /tcp:8081/);
          assert.match((error as Error).message, /reverse/i);
          return true;
        },
      );
    },
  );
});

test('openAndroidApp binds deep link URLs to the requested package', async () => {
  await withMockedAdb(
    'agent-device-android-open-deep-link-package-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ]; then',
      '  echo "package:com.example.app"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "start" ]; then',
      '  echo "Status: ok"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.example.app', { url: 'example://bottom-tabs' });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\nam\nstart\n-W\n-a\nandroid\.intent\.action\.VIEW/);
      assert.match(logged, /-d\nexample:\/\/bottom-tabs/);
      assert.match(logged, /-p\ncom\.example\.app/);
    },
  );
});

test('setAndroidSetting appearance toggle flips current mode', async () => {
  await withMockedAdb(
    'agent-device-android-appearance-toggle-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ] && [ "$4" = "cmd" ] && [ "$5" = "uimode" ] && [ "$6" = "night" ] && [ -z "$7" ]; then',
      '  echo "Night mode: yes"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'appearance', 'toggle');
      const lines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      const logged = lines.join(' ');
      assert.match(logged, /shell cmd uimode night __CMD__/);
      assert.match(logged, /shell cmd uimode night no/);
    },
  );
});

test('setAndroidSetting appearance toggle from auto sets dark mode', async () => {
  await withMockedAdb(
    'agent-device-android-appearance-toggle-auto-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ] && [ "$4" = "cmd" ] && [ "$5" = "uimode" ] && [ "$6" = "night" ] && [ -z "$7" ]; then',
      '  echo "Night mode: auto"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'appearance', 'toggle');
      const lines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      const logged = lines.join(' ');
      assert.match(logged, /shell cmd uimode night yes/);
    },
  );
});

test('setAndroidSetting appearance toggle rejects unknown current mode output', async () => {
  await withMockedAdb(
    'agent-device-android-appearance-toggle-unknown-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ] && [ "$4" = "cmd" ] && [ "$5" = "uimode" ] && [ "$6" = "night" ] && [ -z "$7" ]; then',
      '  echo "mode unavailable"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ device }) => {
      await assert.rejects(
        () => setAndroidSetting(device, 'appearance', 'toggle'),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'COMMAND_FAILED');
          assert.match(
            (error as AppError).message,
            /Unable to determine current Android appearance/,
          );
          return true;
        },
      );
    },
  );
});

test('rotateAndroid locks auto-rotate and sets user rotation', async () => {
  await withMockedAdb(
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

test('setAndroidSetting clear-app-state force stops and clears package data', async () => {
  await withMockedAdb(
    'agent-device-android-clear-app-state-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "force-stop" ] && [ "$4" = "com.example.app" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "clear" ] && [ "$4" = "com.example.app" ]; then',
      '  echo "Success"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      const result = await setAndroidSetting(device, 'clear-app-state', 'clear', 'com.example.app');
      assert.deepEqual(result, { package: 'com.example.app', cleared: true });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\nam\nforce-stop\ncom\.example\.app/);
      assert.match(logged, /shell\npm\nclear\ncom\.example\.app/);
    },
  );
});

test('setAndroidSetting fingerprint retries emulator command when shell cmd fingerprint fails', async () => {
  await withMockedAdb(
    'agent-device-android-fingerprint-fallback-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "cmd" ] && [ "$3" = "fingerprint" ]; then',
      '  echo "fingerprint cmd unavailable" >&2',
      '  exit 1',
      'fi',
      'if [ "$1" = "emu" ] && [ "$2" = "finger" ] && [ "$3" = "touch" ] && [ "$4" = "1" ]; then',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'fingerprint', 'match');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\ncmd\nfingerprint\ntouch\n1/);
      assert.match(logged, /shell\ncmd\nfingerprint\nfinger\n1/);
      assert.match(logged, /emu\nfinger\ntouch\n1/);
    },
  );
});

test('setAndroidSetting fingerprint rejects unsupported action', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  await assert.rejects(
    () => setAndroidSetting(device, 'fingerprint', 'enroll'),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /Invalid fingerprint state/);
      return true;
    },
  );
});

test('setAndroidSetting fingerprint returns COMMAND_FAILED for transport/runtime failures', async () => {
  await withMockedAdb(
    'agent-device-android-fingerprint-command-failed-',
    ['#!/bin/sh', 'echo "error: device offline" >&2', 'exit 1', ''].join('\n'),
    async ({ device }) => {
      await assert.rejects(
        () => setAndroidSetting(device, 'fingerprint', 'match'),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'COMMAND_FAILED');
          assert.match((error as AppError).message, /Failed to simulate Android fingerprint/);
          return true;
        },
      );
    },
  );
});

test('setAndroidSetting fingerprint does not use adb emu command on physical devices', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-android-fingerprint-device-'),
  );
  const adbPath = path.join(tmpDir, 'adb');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    adbPath,
    '#!/bin/sh\nprintf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\necho "unknown command" >&2\nexit 1\n',
    'utf8',
  );
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  const device: DeviceInfo = {
    platform: 'android',
    id: 'R5CT11',
    name: 'Pixel Device',
    kind: 'device',
    booted: true,
  };

  try {
    await assert.rejects(() => setAndroidSetting(device, 'fingerprint', 'match'));
    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.doesNotMatch(logged, /\nemu\nfinger\ntouch\n/);
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

test('resolveAndroidApp does not treat file paths as package names', async () => {
  await withMockedAdb(
    'agent-device-android-resolve-path-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then shift; shift; fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ]; then',
      '  echo "package:com.example.demo"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ device }) => {
      await assert.rejects(
        resolveAndroidApp(device, '/path/to/app-debug.apk'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'APP_NOT_INSTALLED');
          return true;
        },
      );
    },
  );
});

test('resolveAndroidApp caches display-name package matches but bypasses exact package ids', async () => {
  await withMockedAdb(
    'agent-device-android-resolve-cache-',
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then shift; shift; fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ] && [ "$4" = "packages" ]; then',
      '  echo "package:com.example.cachemaps"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      const first = await resolveAndroidApp(device, 'cachemaps');
      const second = await resolveAndroidApp(device, 'cachemaps');
      const exact = await resolveAndroidApp(device, 'com.example.cachemaps');

      assert.deepEqual(first, { type: 'package', value: 'com.example.cachemaps' });
      assert.deepEqual(second, first);
      assert.deepEqual(exact, { type: 'package', value: 'com.example.cachemaps' });

      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.equal((logged.match(/pm list packages/g) ?? []).length, 1);
    },
  );
});

test('installAndroidInstallablePath invalidates cached display-name package matches', async () => {
  await withMockedAdb(
    'agent-device-android-install-cache-',
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then shift; shift; fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ] && [ "$4" = "packages" ]; then',
      '  if [ -f "$AGENT_DEVICE_TEST_INSTALL_MARKER" ]; then',
      '    echo "package:com.example.installedcachemaps"',
      '  else',
      '    echo "package:com.example.cachemaps"',
      '  fi',
      '  exit 0',
      'fi',
      'if [ "$1" = "install" ] && [ "$2" = "-r" ]; then',
      '  : > "$AGENT_DEVICE_TEST_INSTALL_MARKER"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    async ({ device }) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-android-cache-apk-'));
      const apkPath = path.join(tmpDir, 'App.apk');
      const previousMarker = process.env.AGENT_DEVICE_TEST_INSTALL_MARKER;
      process.env.AGENT_DEVICE_TEST_INSTALL_MARKER = path.join(tmpDir, 'installed.marker');
      try {
        await fs.writeFile(apkPath, '', 'utf8');
        const before = await resolveAndroidApp(device, 'cachemaps');
        await installAndroidInstallablePath(device, apkPath);
        const after = await resolveAndroidApp(device, 'cachemaps');

        assert.deepEqual(before, { type: 'package', value: 'com.example.cachemaps' });
        assert.deepEqual(after, { type: 'package', value: 'com.example.installedcachemaps' });
      } finally {
        if (previousMarker === undefined) {
          delete process.env.AGENT_DEVICE_TEST_INSTALL_MARKER;
        } else {
          process.env.AGENT_DEVICE_TEST_INSTALL_MARKER = previousMarker;
        }
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
});

test('openAndroidApp default launch uses -p package flag', async () => {
  await withMockedAdb(
    'agent-device-android-open-default-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.example.app');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\nam\nstart\n-W\n-a\nandroid\.intent\.action\.MAIN/);
      assert.match(logged, /-p\ncom\.example\.app/);
    },
  );
});

test('openAndroidApp appends launchArgs to am start when launching by package', async () => {
  await withMockedAdb(
    'agent-device-android-open-launch-args-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.example.app', {
        launchArgs: ['--es', 'screen', 'home', '--ez', 'fresh', 'true'],
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /-p\ncom\.example\.app\n--es\nscreen\nhome\n--ez\nfresh\ntrue/);
    },
  );
});

test('openAndroidApp appends launchArgs to am start when activity override is set', async () => {
  await withMockedAdb(
    'agent-device-android-open-launch-args-activity-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.example.app', {
        activity: '.MainActivity',
        launchArgs: ['--es', 'mode', 'debug'],
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /-n\ncom\.example\.app\/\.MainActivity\n--es\nmode\ndebug/);
    },
  );
});

test('openAndroidApp appends launchArgs to am start for deep link URL opens', async () => {
  await withMockedAdb(
    'agent-device-android-open-launch-args-url-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'myapp://item/42', {
        launchArgs: ['--es', 'ref', 'campaign'],
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /-d\nmyapp:\/\/item\/42\n--es\nref\ncampaign/);
    },
  );
});

test('openAndroidApp appends launchArgs to am start for app-bound URL opens', async () => {
  await withMockedAdb(
    'agent-device-android-open-launch-args-app-bound-url-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.example.app', {
        url: 'https://example.com/promo',
        launchArgs: ['--es', 'ref', 'campaign'],
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(
        logged,
        /-d\nhttps:\/\/example\.com\/promo\n-p\ncom\.example\.app\n--es\nref\ncampaign/,
      );
    },
  );
});

test('openAndroidApp shell-quotes launchArgs containing JSON or shell metacharacters', async () => {
  await withMockedAdb(
    'agent-device-android-open-launch-args-quoting-',
    androidOpenAdbScript(),
    async ({ argsLogPath, device }) => {
      // Value contains characters the device shell would otherwise re-interpret:
      // `#` (comment), `;` (statement separator), `&` (background), `*` (glob),
      // ` ` (word separator), `\` (escape).
      const jsonPayload = '{"a":"x #y;z&w","b":"path/*"}';
      await openAndroidApp(device, 'com.example.app', {
        launchArgs: ['--es', 'EXTRA_CONFIG', jsonPayload],
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      // `--es` and the safe extra key pass through unquoted; the JSON value
      // is single-quoted so `adb shell` re-tokenisation preserves it.
      assert.match(logged, /--es\nEXTRA_CONFIG\n'\{"a":"x #y;z&w","b":"path\/\*"\}'/);
    },
  );
});

test('openAndroidApp normalizes missing package launch failures into APP_NOT_INSTALLED', async () => {
  await withMockedAdb(
    'agent-device-android-open-missing-package-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "start" ]; then',
      '  echo "Error: Activity class does not exist." >&2',
      '  exit 1',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "path" ]; then',
      '  echo "Error: unknown package: com.example.missing" >&2',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ device }) => {
      await assert.rejects(
        openAndroidApp(device, 'com.example.missing', '.MainActivity'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'APP_NOT_INSTALLED');
          assert.match(String(error.details?.hint ?? ''), /agent-device apps --platform android/);
          return true;
        },
      );
    },
  );
});

test('openAndroidApp uses LEANBACK category for Android TV targets', async () => {
  await withMockedAdb(
    'agent-device-android-open-tv-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ]; then',
      '  echo "package:com.example.tvapp"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "start" ]; then',
      '  echo "Status: ok"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      device.target = 'tv';
      await openAndroidApp(device, 'com.example.tvapp');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /-c\nandroid\.intent\.category\.LEANBACK_LAUNCHER/);
      assert.match(logged, /-p\ncom\.example\.tvapp/);
    },
  );
});

test('openAndroidApp fallback resolve-activity includes MAIN/LAUNCHER flags', async () => {
  await withMockedAdb(
    'agent-device-android-open-fallback-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ]; then',
      '  echo "package:com.microsoft.office.outlook"',
      '  exit 0',
      'fi',
      '# First am start (with -p) outputs error but exits 0 (real Android behavior)',
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "start" ]; then',
      '  for arg in "$@"; do',
      '    if [ "$arg" = "-p" ]; then',
      '      echo "Starting: Intent { act=android.intent.action.MAIN cat=[android.intent.category.DEFAULT,android.intent.category.LAUNCHER] pkg=com.microsoft.office.outlook }"',
      '      echo "Error: Activity not started, unable to resolve Intent { act=android.intent.action.MAIN cat=[android.intent.category.DEFAULT,android.intent.category.LAUNCHER] flg=0x10000000 pkg=com.microsoft.office.outlook }"',
      '      exit 0',
      '    fi',
      '  done',
      '  echo "Status: ok"',
      '  exit 0',
      'fi',
      '# resolve-activity returns correct launcher component',
      'if [ "$1" = "shell" ] && [ "$2" = "cmd" ] && [ "$3" = "package" ] && [ "$4" = "resolve-activity" ]; then',
      '  echo "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true"',
      '  echo "com.microsoft.office.outlook/com.microsoft.office.outlook.ui.miit.MiitLauncherActivity"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await openAndroidApp(device, 'com.microsoft.office.outlook');
      const logged = await fs.readFile(argsLogPath, 'utf8');
      // Verify resolve-activity was called with MAIN/LAUNCHER flags
      assert.match(
        logged,
        /resolve-activity\n--brief\n-a\nandroid\.intent\.action\.MAIN\n-c\nandroid\.intent\.category\.LAUNCHER\ncom\.microsoft\.office\.outlook/,
      );
      // Verify fallback launch used the resolved component
      assert.match(
        logged,
        /-n\ncom\.microsoft\.office\.outlook\/com\.microsoft\.office\.outlook\.ui\.miit\.MiitLauncherActivity/,
      );
    },
  );
});

test('parseAndroidLaunchComponent handles multi-entry resolve output', () => {
  // Some devices return extra metadata lines before the component
  const stdout = [
    'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true',
    'com.microsoft.office.outlook/com.microsoft.office.outlook.ui.miit.MiitLauncherActivity',
  ].join('\n');
  assert.equal(
    parseAndroidLaunchComponent(stdout),
    'com.microsoft.office.outlook/com.microsoft.office.outlook.ui.miit.MiitLauncherActivity',
  );
});

test('typeAndroid chunks ASCII input text for shell fallback', async () => {
  await withMockedAdb(
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
  await withMockedAdb(
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
  await withMockedAdb(
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
  await withMockedAdb(
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
  await withMockedAdb(
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
});

test('fillAndroid keeps delayed typing in typed-input mode', async () => {
  await withMockedAdb(
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
});

test('fillAndroid tolerates delayed React Native text verification', async () => {
  await withMockedAdb(
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
});

test('typeAndroid reports clear error when unicode input is unsupported', async () => {
  await withMockedAdb(
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

test('getAndroidKeyboardState reads visibility and input type', async () => {
  await withMockedAdb(
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
  await withMockedAdb(
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
  await withMockedAdb(
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
  await withMockedAdb(
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
  await withMockedAdb(
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
  await withMockedAdb(
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
  await withMockedAdb(
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
  await withMockedAdb(
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
  await withMockedAdb(
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
  await withMockedAdb(
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

test('setAndroidSetting permission deny notifications revokes runtime permission and appops', async () => {
  await withMockedAdb(
    'agent-device-android-permission-notifications-',
    '#!/bin/sh\nprintf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'permission', 'deny', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(
        logged,
        /shell\npm\nrevoke\ncom\.example\.app\nandroid\.permission\.POST_NOTIFICATIONS/,
      );
      assert.match(logged, /shell\nappops\nset\ncom\.example\.app\nPOST_NOTIFICATION\ndeny/);
    },
  );
});

test('setAndroidSetting permission reset notifications clears permission flags for reprompt', async () => {
  await withMockedAdb(
    'agent-device-android-permission-notifications-reset-',
    '#!/bin/sh\nprintf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(
        logged,
        /shell\npm\nrevoke\ncom\.example\.app\nandroid\.permission\.POST_NOTIFICATIONS/,
      );
      assert.match(
        logged,
        /shell\npm\nclear-permission-flags\ncom\.example\.app\nandroid\.permission\.POST_NOTIFICATIONS\nuser-set/,
      );
      assert.match(
        logged,
        /shell\npm\nclear-permission-flags\ncom\.example\.app\nandroid\.permission\.POST_NOTIFICATIONS\nuser-fixed/,
      );
      assert.match(logged, /shell\nappops\nset\ncom\.example\.app\nPOST_NOTIFICATION\ndefault/);
    },
  );
});

test('setAndroidSetting permission reset camera maps to pm revoke', async () => {
  await withMockedAdb(
    'agent-device-android-permission-reset-',
    '#!/bin/sh\nprintf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'camera',
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\npm\nrevoke\ncom\.example\.app\nandroid\.permission\.CAMERA/);
    },
  );
});

test('setAndroidSetting permission rejects mode argument', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  await assert.rejects(
    () =>
      setAndroidSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'camera',
        permissionMode: 'limited',
      }),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /mode is only supported for photos/i);
      return true;
    },
  );
});

test('setAndroidSetting permission rejects iOS-only targets with Android-specific guidance', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  await assert.rejects(
    () =>
      setAndroidSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'calendar',
      }),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /Unsupported permission target on Android/i);
      return true;
    },
  );
});

test('setAndroidSetting permission grant photos falls back to legacy permission on older SDK', async () => {
  await withMockedAdb(
    'agent-device-android-permission-photos-fallback-',
    [
      '#!/bin/sh',
      'printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "getprop" ] && [ "$3" = "ro.build.version.sdk" ]; then',
      '  echo "32"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "grant" ] && [ "$5" = "android.permission.READ_EXTERNAL_STORAGE" ]; then',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      await setAndroidSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'photos',
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /shell\ngetprop\nro\.build\.version\.sdk/);
      assert.match(
        logged,
        /shell\npm\ngrant\ncom\.example\.app\nandroid\.permission\.READ_EXTERNAL_STORAGE/,
      );
    },
  );
});

test('pushAndroidNotification broadcasts action with typed extras', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-android-push-test-'));
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
    const result = await pushAndroidNotification(device, 'com.example.app', {
      action: 'com.example.app.PUSH',
      extras: {
        title: 'Hello',
        unread: 3,
        promo: true,
        ratio: 0.5,
      },
    });
    assert.equal(result.action, 'com.example.app.PUSH');
    assert.equal(result.extrasCount, 4);
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, [
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'broadcast',
      '-a',
      'com.example.app.PUSH',
      '-p',
      'com.example.app',
      '--es',
      'title',
      'Hello',
      '--ei',
      'unread',
      '3',
      '--ez',
      'promo',
      'true',
      '--ef',
      'ratio',
      '0.5',
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

test('pushAndroidNotification ignores empty extra keys when reporting extrasCount', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-android-push-empty-key-test-'),
  );
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
    const result = await pushAndroidNotification(device, 'com.example.app', {
      extras: {
        '': 'ignored',
        title: 'Welcome',
      },
    });
    assert.equal(result.extrasCount, 1);
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim();
    assert.equal(args.includes('\n\n'), false);
    assert.equal(args.includes('ignored'), false);
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
