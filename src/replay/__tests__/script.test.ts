import fc from 'fast-check';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PROPERTY_RUNS, replayScriptArb } from '../../__tests__/test-utils/index.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  parseReplayScriptDetailed,
  readReplayScriptMetadata,
  REPLAY_METADATA_PLATFORMS,
} from '../script.ts';
import { formatPortableActionLine, formatTargetAnnotationLines } from '../script-formatting.ts';
import type { TargetAnnotationV1 } from '../target-identity.ts';
import type { SessionAction } from '../../contracts/session-action.ts';

// `writeReplayScript` (the `--update` heal-and-rewrite serializer) was
// deleted in ADR 0012 migration step 6 (`--update` retirement left it with
// zero production consumers). These tests exercise the underlying
// line-formatting primitives it used to call — still live, still shared with
// the session recorder's own writer (`daemon/session-script-writer.ts`) —
// directly, plus `parseReplayScriptDetailed` for round-trip proof.

function formatReplayScriptForTest(actions: SessionAction[]): string {
  const lines: string[] = [];
  for (const action of actions) {
    lines.push(...formatTargetAnnotationLines(action));
    lines.push(formatPortableActionLine(action, { runtimeIncludeAllPositionals: true }));
  }
  return `${lines.join('\n')}\n`;
}

test('formatPortableActionLine preserves inline open runtime hints', () => {
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

  const script = formatReplayScriptForTest(actions);

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

  const script = formatReplayScriptForTest(actions);
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

  const script = formatReplayScriptForTest(actions);

  assert.match(script, /snapshot -i -d 2 -s @e1/);
});

test('a pre-removal gesture line fails the whole script instead of step N', () => {
  assert.throws(
    () =>
      parseReplayScriptDetailed(
        [
          'open com.apple.Preferences --relaunch',
          '',
          'swipe 197 650 197 300 300',
          'wait 500',
          '',
        ].join('\n'),
      ),
    {
      code: 'INVALID_ARGS',
      message:
        'swipe accepts 4 arguments: x1 y1 x2 y2 (line 3). The trailing durationMs positional was removed: use "gesture pan 197 650 0 -350 300" for the same timed drag, or "swipe 197 650 197 300" for a default-duration swipe.',
    },
  );
  assert.throws(
    () =>
      parseReplayScriptDetailed(
        ['open com.example.app', 'gesture rotate 35 195 443 800'].join('\n'),
      ),
    {
      code: 'INVALID_ARGS',
      message: /gesture rotate accepts at most 3 arguments: degrees \[x\] \[y\] \(line 2\)\./,
    },
  );
});

test('gesture replay script parses pan, fling, swipe, pinch, and rotate gesture commands', () => {
  const parsed = parseReplayScriptDetailed(
    [
      'gesture pan 195 443 80 0 --pointer-count 2',
      'wait "pan changed yes" 5000',
      'gesture fling right 195 443 180',
      'gesture swipe right-edge',
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
  assert.equal(parsed[0]?.flags.pointerCount, 2);
  assert.deepEqual(parsed[2]?.positionals, ['fling', 'right', '195', '443', '180']);
  assert.deepEqual(parsed[3]?.positionals, ['swipe', 'right-edge']);
  assert.deepEqual(parsed[4]?.positionals, ['pinch', '1.25', '195', '443']);
  assert.deepEqual(parsed[5]?.positionals, ['rotate', '35', '195', '443']);
});

test('type and fill replay scripts round-trip typing delay flags', () => {
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

  const script = formatReplayScriptForTest(actions);
  assert.match(script, /type "hello world" --delay-ms 75/);
  assert.match(script, /fill @e2 "search" --delay-ms 40/);

  const parsed = parseReplayScriptDetailed(script).actions;
  assert.equal(parsed[0]?.flags.delayMs, 75);
  assert.equal(parsed[1]?.flags.delayMs, 40);
});

test('coordinate fill replay scripts preserve both coordinates and parameterized text', () => {
  const script = formatReplayScriptForTest([
    {
      ts: Date.now(),
      command: 'fill',
      positionals: ['100', '482', '${PASSWORD}'],
      flags: {},
    },
  ]);

  assert.match(script, /fill 100 482 "\$\{PASSWORD\}"/);
  assert.deepEqual(parseReplayScriptDetailed(script).actions[0]?.positionals, [
    '100',
    '482',
    '${PASSWORD}',
  ]);
});

test('type replay script preserves literal delay flag tokens', () => {
  const parsed = parseReplayScriptDetailed('type "--delay-ms" "abc"\n').actions;
  assert.deepEqual(parsed[0]?.positionals, ['--delay-ms', 'abc']);
  assert.equal(parsed[0]?.flags.delayMs, undefined);
});

test('formatScriptStringLiteral escapes device labels with quotes and backslashes for a context header', async () => {
  const { formatScriptStringLiteral } = await import('../script-utils.ts');
  // Same assembly the live session-script-writer uses
  // (daemon/session-script-writer.ts's formatScript): `context platform=...
  // device=<literal> kind=... theme=...`.
  const header = `context platform=android device=${formatScriptStringLiteral('Pixel "QA" \\ Lab')} kind=emulator theme=unknown`;
  assert.equal(
    header,
    'context platform=android device="Pixel \\"QA\\" \\\\ Lab" kind=emulator theme=unknown',
  );
  // And it round-trips through the reader as ordinary context metadata.
  assert.equal(readReplayScriptMetadata(`${header}\nopen "Demo"\n`).platform, 'android');
});

test('a rewritten script preserves significant whitespace and empty string arguments', () => {
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

  const script = formatReplayScriptForTest(actions);

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
    'vega',
  ]);
});

test('readReplayScriptMetadata accepts every concrete leaf platform', () => {
  for (const platform of ['ios', 'android', 'vega', 'macos', 'linux'] as const) {
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

test('parseReplayScriptDetailed tracks line numbers', () => {
  const script = [
    '# comment',
    'context platform=android',
    'env APP=settings',
    '',
    'open ${APP}',
    'wait 500',
  ].join('\n');
  const parsed = parseReplayScriptDetailed(script);
  assert.equal(parsed.actions.length, 2);
  assert.deepEqual(parsed.actionLines, [5, 6]);
});

test('readReplayScriptMetadata parses env KEY=VALUE directives', () => {
  const metadata = readReplayScriptMetadata(
    'context platform=android\nenv APP=settings\nenv WAIT=500\nopen ${APP}\n',
  );
  assert.equal(metadata.env?.APP, 'settings');
  assert.equal(metadata.env?.WAIT, '500');
});

test('readReplayScriptMetadata accepts env before context', () => {
  const metadata = readReplayScriptMetadata(
    'env APP=settings\ncontext platform=ios target=mobile\n',
  );
  assert.equal(metadata.platform, 'ios');
  assert.equal(metadata.target, 'mobile');
  assert.equal(metadata.env?.APP, 'settings');
});

test('readReplayScriptMetadata parses quoted env values with spaces', () => {
  const metadata = readReplayScriptMetadata(
    'context platform=android\nenv SEL="label=Wait || label=Apps"\n',
  );
  assert.equal(metadata.env?.SEL, 'label=Wait || label=Apps');
});

test('readReplayScriptMetadata rejects invalid env key', () => {
  assert.throws(
    () => readReplayScriptMetadata('context platform=android\nenv lower=settings\n'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Invalid env key "lower"/.test(error.message),
  );
});

test('readReplayScriptMetadata rejects duplicate env key', () => {
  assert.throws(
    () => readReplayScriptMetadata('context platform=android\nenv APP=a\nenv APP=b\n'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Duplicate env directive "APP"/.test(error.message),
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

// Found by the nightly parser fuzz lane (#1414): the closing-quote scan accepted these
// literals and the JSON decode behind it leaked a raw SyntaxError.
test.each([
  ['invalid escape', 'fill @e1 --text "hello wor\\ld"'],
  ['raw control character', 'fill @e1 --text "hel\u0000lo"'],
  ['raw tab', 'fill @e1 --text "hello\tworld"'],
])('a quoted value with an %s is rejected as INVALID_ARGS with a hint', (_case, script) => {
  assert.throws(
    () => parseReplayScriptDetailed(script),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      typeof error.details?.hint === 'string' &&
      error.details.hint.length > 0,
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

test('a rewritten script preserves a v1 annotation in canonical form', () => {
  const actions: SessionAction[] = [
    {
      ts: Date.now(),
      command: 'click',
      positionals: ['@e12'],
      flags: {},
      targetEvidence: SAVE_EVIDENCE,
    },
  ];

  const script = formatReplayScriptForTest(actions);
  const lines = script.trim().split('\n');
  assert.equal(lines.at(-2), SAVE_EVIDENCE_LINE);
  assert.equal(lines.at(-1), 'click @e12');

  // Round trip: re-parsing the rewritten script recovers the same evidence.
  const reparsed = parseReplayScriptDetailed(script);
  assert.deepEqual(reparsed.actions[0]?.targetEvidence, SAVE_EVIDENCE);
});

test('session-recorded actions without target evidence never gain a fabricated annotation on rewrite', () => {
  const actions: SessionAction[] = [
    { ts: Date.now(), command: 'click', positionals: ['@e12'], flags: {} },
  ];
  const script = formatReplayScriptForTest(actions);
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

// Property, not another example: `.ad` scripts are written by hand, recorded,
// and rewritten, so the parser and the line formatter must agree on ONE
// canonical form — re-serializing a parsed script has to be a fixed point.
// Generated lines come from the shared `.ad` generator, so a new command shape
// extends the generator rather than adding another pinned script here.
test('serializing a parsed script is a fixed point for generated scripts', () => {
  fc.assert(
    fc.property(replayScriptArb, (script) => {
      const parsed = parseReplayScriptDetailed(script).actions;
      const canonical = formatReplayScriptForTest(parsed);
      const reparsed = parseReplayScriptDetailed(canonical).actions;
      assert.equal(formatReplayScriptForTest(reparsed), canonical);
      // The action identity survives the rewrite: same commands, same targets.
      assert.deepEqual(
        reparsed.map((action) => [action.command, action.positionals]),
        parsed.map((action) => [action.command, action.positionals]),
      );
    }),
    { numRuns: PROPERTY_RUNS },
  );
});
