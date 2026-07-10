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
import type { TargetAnnotationV1 } from '../target-identity.ts';
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
      flags: {
        screenshotPixelDensity: 2,
        screenshotFullscreen: true,
        screenshotMaxSize: 1024,
        screenshotNoStabilize: true,
      },
    },
  ];

  writeReplayScript(replayPath, actions, makeSession());
  const script = fs.readFileSync(replayPath, 'utf8');
  assert.match(
    script,
    /screenshot "\.\/page\.png" --pixel-density 2 --fullscreen --max-size 1024 --no-stabilize/,
  );

  const parsed = parseReplayScriptDetailed(script).actions;
  assert.deepEqual(parsed[0]?.positionals, ['./page.png']);
  assert.equal(parsed[0]?.flags.screenshotPixelDensity, 2);
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

test('readReplayScriptMetadata accepts the apple selector alias', () => {
  const metadata = readReplayScriptMetadata(
    'context platform=apple device="Host Mac"\nopen "Demo"\n',
  );

  assert.equal(metadata.platform, 'apple');
});

test('REPLAY_METADATA_PLATFORMS is exactly the non-web leaf platforms', () => {
  assert.deepEqual([...REPLAY_METADATA_PLATFORMS].sort(), [
    'android',
    'apple',
    'ios',
    'linux',
    'macos',
  ]);
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

test('replay parsing strips versioned-ref pins from recorded refs (#1076)', () => {
  // Generations are session-scoped; a replayed script runs against a NEW
  // session, so pins are stripped and IGNORED rather than re-validated.
  const script = [
    'context platform=android device=Pixel',
    'press @e2~s3 Continue',
    'fill @e4~s3 Email hello@example.com',
    'get text @e5~s3 Title',
    'wait @e2~s3 5000',
    'longpress @e2~s3 800',
  ].join('\n');

  const { actions } = parseReplayScriptDetailed(script);
  assert.deepEqual(
    actions.map((action) => action.positionals),
    [['@e2'], ['@e4', 'hello@example.com'], ['text', '@e5'], ['@e2', '5000'], ['@e2', '800']],
  );
  // Malformed pins were never minted by us — left for the daemon to reject.
  const malformed = parseReplayScriptDetailed('press @e2~x3').actions[0];
  assert.deepEqual(malformed?.positionals, ['@e2~x3']);
});

// ---------------------------------------------------------------------------
// ADR 0012 decision 3: `.ad` target-v1 annotation parsing/binding/preservation
// (migration step 3 — parser/writer only, no replay-time enforcement).
// ---------------------------------------------------------------------------

const SAVE_EVIDENCE: TargetAnnotationV1 = {
  id: 'save',
  role: 'button',
  label: 'Save',
  ancestry: [{ role: 'toolbar', label: 'Editor' }, { role: 'window' }],
  sibling: 0,
  viewportOrder: 0,
  scrollRegion: { role: 'scrollview', id: 'editor-scroll' },
  verification: 'verified',
};

const SAVE_EVIDENCE_LINE =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[{"role":"toolbar","label":"Editor"},{"role":"window"}],"sibling":0,"viewportOrder":0,"scrollRegion":{"role":"scrollview","id":"editor-scroll"},"verification":"verified"}';

test('a target-v1 annotation immediately preceding an action line attaches to that action', () => {
  const script = [
    'context platform=ios device=iPhone',
    SAVE_EVIDENCE_LINE,
    'click @e12 "Save"',
  ].join('\n');
  const { actions } = parseReplayScriptDetailed(script);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0]?.targetEvidence, SAVE_EVIDENCE);
});

test('a target-v1 annotation followed by a blank line before the action is rejected as INVALID_ARGS', () => {
  const script = [SAVE_EVIDENCE_LINE, '', 'click @e12 "Save"'].join('\n');
  assert.throws(
    () => parseReplayScriptDetailed(script),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /must be immediately followed by its action line/.test(error.message),
  );
});

test('a target-v1 annotation followed by another comment before the action is rejected as INVALID_ARGS', () => {
  const script = [SAVE_EVIDENCE_LINE, '# note', 'click @e12 "Save"'].join('\n');
  assert.throws(
    () => parseReplayScriptDetailed(script),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('a target-v1 annotation as the last line of the script (no action follows) is rejected as INVALID_ARGS', () => {
  assert.throws(
    () => parseReplayScriptDetailed(SAVE_EVIDENCE_LINE),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('a malformed target-v1 payload is rejected as INVALID_ARGS, not silently dropped', () => {
  const script = ['# agent-device:target-v1 {not json', 'click @e12 "Save"'].join('\n');
  assert.throws(
    () => parseReplayScriptDetailed(script),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('an unknown future target-vN comment is an ordinary comment: no binding requirement, no evidence attached', () => {
  const script = ['# agent-device:target-v2 {"whatever":true}', '', 'click @e12 "Save"'].join('\n');
  const { actions } = parseReplayScriptDetailed(script);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.targetEvidence, undefined);
});

test('old readers ignoring the comment execute the action unchanged: an action without a preceding annotation carries no targetEvidence', () => {
  const { actions } = parseReplayScriptDetailed('click @e12 "Save"');
  assert.equal(actions[0]?.targetEvidence, undefined);
});

test('writeReplayScript (read-then-rewrite / heal path) preserves a v1 annotation in canonical form', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-script-target-v1-'));
  const replayPath = path.join(root, 'flow.ad');
  const actions: SessionAction[] = [
    {
      ts: Date.now(),
      command: 'click',
      positionals: ['@e12'],
      flags: {},
      targetEvidence: SAVE_EVIDENCE,
    },
  ];

  writeReplayScript(replayPath, actions, makeSession());
  const script = fs.readFileSync(replayPath, 'utf8');
  const lines = script.trim().split('\n');
  assert.equal(lines.at(-2), SAVE_EVIDENCE_LINE);
  assert.equal(lines.at(-1), 'click @e12');

  // Round trip: re-parsing the rewritten script recovers the same evidence.
  const reparsed = parseReplayScriptDetailed(script);
  assert.deepEqual(reparsed.actions[0]?.targetEvidence, SAVE_EVIDENCE);
});

test('session-recorded actions without target evidence never gain a fabricated annotation on rewrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-script-target-v1-none-'));
  const replayPath = path.join(root, 'flow.ad');
  const actions: SessionAction[] = [
    { ts: Date.now(), command: 'click', positionals: ['@e12'], flags: {} },
  ];
  writeReplayScript(replayPath, actions, makeSession());
  const script = fs.readFileSync(replayPath, 'utf8');
  assert.equal(/agent-device:target-v1/.test(script), false);
});

test('formatDivergenceActionLabel categorically drops fill/type text but keeps the target', async () => {
  const { formatDivergenceActionLabel } = await import('../script-utils.ts');
  const mk = (command: string, positionals: string[]): SessionAction => ({
    ts: 0,
    command,
    positionals,
    flags: {},
  });
  const secret = 'hunter2-secret';
  // fill selector text (selector token is script-quoted, text dropped)
  assert.equal(
    formatDivergenceActionLabel(mk('fill', ['label="Email"', secret])),
    'fill "label=\\"Email\\"" <text>',
  );
  // fill @ref text
  assert.equal(formatDivergenceActionLabel(mk('fill', ['@e5', secret])), 'fill @e5 <text>');
  // fill point text
  assert.equal(formatDivergenceActionLabel(mk('fill', ['10', '20', secret])), 'fill 10 20 <text>');
  // type text (no target)
  assert.equal(formatDivergenceActionLabel(mk('type', [secret])), 'type <text>');
  // none of these leak the secret
  for (const label of [
    formatDivergenceActionLabel(mk('fill', ['label="Email"', secret])),
    formatDivergenceActionLabel(mk('fill', ['@e5', secret])),
    formatDivergenceActionLabel(mk('type', [secret, 'more', secret])),
  ]) {
    assert.equal(label.includes(secret), false);
  }
  // non-typing commands are unchanged (full summary, script-quoted).
  assert.equal(
    formatDivergenceActionLabel(mk('click', ['label="Save"'])),
    'click "label=\\"Save\\""',
  );
});
