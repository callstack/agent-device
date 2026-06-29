import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../kernel/errors.ts';
import {
  parseReplayScriptDetailed,
  readReplayScriptMetadata,
  REPLAY_METADATA_PLATFORMS,
  writeReplayScript,
} from '../script.ts';
import type { SessionAction, SessionState } from '../../daemon/types.ts';

function makeSession(): SessionState {
  return {
    name: 'default',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
  };
}

test('writeReplayScript preserves inline open runtime hints', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-script-open-'));
  const replayPath = path.join(root, 'flow.ad');
  const actions: SessionAction[] = [
    {
      ts: Date.now(),
      command: 'open',
      positionals: ['Demo'],
      runtime: {
        platform: 'android',
        metroHost: '10.0.0.10',
        metroPort: 8081,
        launchUrl: 'myapp://dev',
      },
      flags: { relaunch: true },
    },
  ];

  writeReplayScript(replayPath, actions, makeSession());
  const script = fs.readFileSync(replayPath, 'utf8');

  assert.match(
    script,
    /open "Demo" --relaunch --platform android --metro-host 10\.0\.0\.10 --metro-port 8081 --launch-url myapp:\/\/dev/,
  );
});

test('record replay script parses fps, max-size, quality, and hide-touches flags', () => {
  const script =
    'record start "./capture.mp4" --fps 24 --max-size 1024 --quality high --hide-touches\n';
  const parsed = parseReplayScriptDetailed(script).actions;

  assert.deepEqual(parsed[0]?.positionals, ['start', './capture.mp4']);
  assert.equal(parsed[0]?.flags.fps, 24);
  assert.equal(parsed[0]?.flags.screenshotMaxSize, 1024);
  assert.equal(parsed[0]?.flags.quality, 'high');
  assert.equal(parsed[0]?.flags.hideTouches, true);
});

test('screenshot replay script round-trips screenshot flags', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-script-screenshot-'));
  const replayPath = path.join(root, 'flow.ad');
  const actions: SessionAction[] = [
    {
      ts: Date.now(),
      command: 'screenshot',
      positionals: ['./page.png'],
      flags: { screenshotFullscreen: true, screenshotMaxSize: 1024, screenshotNoStabilize: true },
    },
  ];

  writeReplayScript(replayPath, actions, makeSession());
  const script = fs.readFileSync(replayPath, 'utf8');
  assert.match(script, /screenshot "\.\/page\.png" --fullscreen --max-size 1024 --no-stabilize/);

  const parsed = parseReplayScriptDetailed(script).actions;
  assert.deepEqual(parsed[0]?.positionals, ['./page.png']);
  assert.equal(parsed[0]?.flags.screenshotFullscreen, true);
  assert.equal(parsed[0]?.flags.screenshotMaxSize, 1024);
  assert.equal(parsed[0]?.flags.screenshotNoStabilize, true);
});

test('snapshot replay script parses full refresh flags', () => {
  const ignoredLegacyFlag = '-' + 'c';
  const parsed = parseReplayScriptDetailed(
    ['snapshot', '-i', ignoredLegacyFlag, '--raw', '--force-full', '-d', '2', '-s', '"@e1"'].join(
      ' ',
    ) + '\n',
  ).actions;

  assert.deepEqual(parsed[0]?.positionals, []);
  assert.equal(parsed[0]?.flags.snapshotInteractiveOnly, true);
  assert.deepEqual(Object.keys(parsed[0]?.flags ?? {}).sort(), [
    'snapshotDepth',
    'snapshotForceFull',
    'snapshotInteractiveOnly',
    'snapshotRaw',
    'snapshotScope',
  ]);
  assert.equal(parsed[0]?.flags.snapshotRaw, true);
  assert.equal(parsed[0]?.flags.snapshotForceFull, true);
  assert.equal(parsed[0]?.flags.snapshotDepth, 2);
  assert.equal(parsed[0]?.flags.snapshotScope, '@e1');
});

test('snapshot replay script writes interactive refresh flags', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-script-snapshot-'));
  const replayPath = path.join(root, 'flow.ad');
  const actions: SessionAction[] = [
    {
      ts: Date.now(),
      command: 'snapshot',
      positionals: [],
      flags: {
        snapshotInteractiveOnly: true,
        snapshotDepth: 2,
        snapshotScope: '@e1',
      },
    },
  ];

  writeReplayScript(replayPath, actions, makeSession());
  const script = fs.readFileSync(replayPath, 'utf8');

  assert.match(script, /snapshot -i -d 2 -s @e1/);
});

test('gesture replay script parses pan, fling, swipe, pinch, and rotate gesture commands', () => {
  const parsed = parseReplayScriptDetailed(
    [
      'gesture pan 195 443 80 0',
      'wait "pan changed yes" 5000',
      'gesture fling right 195 443 180',
      'gesture swipe right-edge 300',
      'gesture pinch 1.25 195 443',
      'gesture rotate 35 195 443',
      '',
    ].join('\n'),
  ).actions;

  assert.deepEqual(
    parsed.map((action) => action.command),
    ['gesture', 'wait', 'gesture', 'gesture', 'gesture', 'gesture'],
  );
  assert.deepEqual(parsed[0]?.positionals, ['pan', '195', '443', '80', '0']);
  assert.deepEqual(parsed[2]?.positionals, ['fling', 'right', '195', '443', '180']);
  assert.deepEqual(parsed[3]?.positionals, ['swipe', 'right-edge', '300']);
  assert.deepEqual(parsed[4]?.positionals, ['pinch', '1.25', '195', '443']);
  assert.deepEqual(parsed[5]?.positionals, ['rotate', '35', '195', '443']);
});

test('type and fill replay scripts round-trip typing delay flags', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-script-typing-'));
  const replayPath = path.join(root, 'flow.ad');
  const actions: SessionAction[] = [
    {
      ts: Date.now(),
      command: 'type',
      positionals: ['hello world'],
      flags: { delayMs: 75 },
    },
    {
      ts: Date.now(),
      command: 'fill',
      positionals: ['@e2', 'search'],
      flags: { delayMs: 40 },
    },
  ];

  writeReplayScript(replayPath, actions, makeSession());
  const script = fs.readFileSync(replayPath, 'utf8');
  assert.match(script, /type "hello world" --delay-ms 75/);
  assert.match(script, /fill @e2 "search" --delay-ms 40/);

  const parsed = parseReplayScriptDetailed(script).actions;
  assert.equal(parsed[0]?.flags.delayMs, 75);
  assert.equal(parsed[1]?.flags.delayMs, 40);
});

test('type replay script preserves literal delay flag tokens', () => {
  const parsed = parseReplayScriptDetailed('type "--delay-ms" "abc"\n').actions;
  assert.deepEqual(parsed[0]?.positionals, ['--delay-ms', 'abc']);
  assert.equal(parsed[0]?.flags.delayMs, undefined);
});

test('writeReplayScript escapes device labels with quotes and backslashes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-script-device-label-'));
  const replayPath = path.join(root, 'flow.ad');
  const session = makeSession();
  session.device.name = 'Pixel "QA" \\ Lab';

  writeReplayScript(replayPath, [], session);
  const script = fs.readFileSync(replayPath, 'utf8');

  assert.match(
    script,
    /context platform=android device="Pixel \\"QA\\" \\\\ Lab" kind=emulator theme=unknown/,
  );
});

test('writeReplayScript preserves significant whitespace and empty string arguments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-script-whitespace-'));
  const replayPath = path.join(root, 'flow.ad');
  const actions: SessionAction[] = [
    {
      ts: Date.now(),
      command: 'type',
      positionals: ['  leading\ttrailing  '],
      flags: {},
    },
    {
      ts: Date.now(),
      command: 'fill',
      positionals: ['@e2', ''],
      flags: {},
    },
    {
      ts: Date.now(),
      command: 'screenshot',
      positionals: [' ./screens/final.png '],
      flags: {},
    },
    {
      ts: Date.now(),
      command: 'screenshot',
      positionals: ['foo\\nbar.png'],
      flags: {},
    },
    {
      ts: Date.now(),
      command: 'open',
      positionals: ['Demo'],
      runtime: {
        platform: 'android',
        metroHost: ' host\t',
        launchUrl: 'myapp://dev ',
      },
      flags: {},
    },
  ];

  writeReplayScript(replayPath, actions, makeSession());
  const script = fs.readFileSync(replayPath, 'utf8');

  assert.match(script, /type "  leading\\ttrailing  "/);
  assert.match(script, /fill @e2 ""/);
  assert.match(script, /screenshot " \.\/screens\/final\.png "/);
  assert.match(script, /screenshot "foo\\\\nbar\.png"/);
  assert.match(script, /--metro-host " host\\t" --launch-url "myapp:\/\/dev "/);

  const parsed = parseReplayScriptDetailed(script).actions;
  assert.deepEqual(parsed[0]?.positionals, ['  leading\ttrailing  ']);
  assert.deepEqual(parsed[1]?.positionals, ['@e2', '']);
  assert.deepEqual(parsed[2]?.positionals, [' ./screens/final.png ']);
  assert.deepEqual(parsed[3]?.positionals, ['foo\\nbar.png']);
  assert.deepEqual(parsed[4]?.positionals, ['Demo']);
  assert.equal(parsed[4]?.runtime?.metroHost, ' host\t');
  assert.equal(parsed[4]?.runtime?.launchUrl, 'myapp://dev ');
});

test('readReplayScriptMetadata extracts platform from context header', () => {
  const metadata = readReplayScriptMetadata(
    '# comment\n\ncontext platform=android device="Pixel 9 Pro"\nopen "Demo"\n',
  );

  assert.equal(metadata.platform, 'android');
});

test('readReplayScriptMetadata ignores non-concrete platform aliases', () => {
  const metadata = readReplayScriptMetadata(
    'context platform=apple device="Host Mac"\nopen "Demo"\n',
  );

  assert.equal(metadata.platform, undefined);
});

test('REPLAY_METADATA_PLATFORMS is exactly the non-web leaf platforms', () => {
  assert.deepEqual([...REPLAY_METADATA_PLATFORMS].sort(), ['android', 'ios', 'linux', 'macos']);
});

test('readReplayScriptMetadata accepts every concrete leaf platform', () => {
  for (const platform of ['ios', 'android', 'macos', 'linux'] as const) {
    const metadata = readReplayScriptMetadata(`context platform=${platform}\nopen "Demo"\n`);

    assert.equal(metadata.platform, platform);
  }
});

test('readReplayScriptMetadata drops unsupported web platform', () => {
  const metadata = readReplayScriptMetadata('context platform=web device="Browser"\nopen "Demo"\n');

  assert.equal(metadata.platform, undefined);
});

test('readReplayScriptMetadata extracts timeout and retries from context header', () => {
  const metadata = readReplayScriptMetadata(
    'context platform=ios timeout=45000\ncontext retries=2 device="iPhone 17"\nopen "Demo"\n',
  );

  assert.equal(metadata.platform, 'ios');
  assert.equal(metadata.timeoutMs, 45000);
  assert.equal(metadata.retries, 2);
});

test('readReplayScriptMetadata rejects duplicate metadata keys in context header', () => {
  assert.throws(
    () =>
      readReplayScriptMetadata(
        'context platform=ios timeout=45000\ncontext platform=ios retries=2\nopen "Demo"\n',
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Duplicate replay test metadata "platform"/.test(error.message),
  );
});

test('readReplayScriptMetadata rejects conflicting metadata keys in context header', () => {
  assert.throws(
    () =>
      readReplayScriptMetadata(
        'context platform=ios timeout=45000\ncontext retries=2 timeout=5000\nopen "Demo"\n',
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Conflicting replay test metadata "timeoutMs"/.test(error.message),
  );
});
