import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../utils/errors.ts';
import { readReplayScriptMetadata, writeReplayScript } from '../script.ts';
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
