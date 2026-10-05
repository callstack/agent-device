import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import {
  parseReplayScriptDetailed,
  readReplayScriptMetadata,
  REPLAY_METADATA_PLATFORMS,
} from '../script.ts';
import { formatPortableActionLine, formatTargetAnnotationLines } from '../script-formatting.ts';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import type { SessionAction } from '@agent-device/contracts/session';

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

test('open replay script round-trips explicit Android test IME selection', () => {
  const actions: SessionAction[] = [
    {
      ts: Date.now(),
      command: 'open',
      positionals: ['Demo'],
      flags: { testIme: false },
    },
    {
      ts: Date.now(),
      command: 'open',
      positionals: ['Demo'],
      flags: { testIme: true },
    },
  ];

  const script = formatReplayScriptForTest(actions);
  assert.match(script, /open "Demo" --no-test-ime/);
  assert.match(script, /open "Demo" --test-ime/);

  const parsed = parseReplayScriptDetailed(script).actions;
  assert.equal(parsed[0]?.flags.testIme, false);
  assert.equal(parsed[1]?.flags.testIme, true);
  assert.deepEqual(parsed[0]?.positionals, ['Demo']);
  assert.deepEqual(parsed[1]?.positionals, ['Demo']);
});

test('record replay script parses fps, quality, and hide-touches flags', () => {
  const script = 'record start "./capture.mp4" --fps 24 --quality high --hide-touches\n';
  const parsed = parseReplayScriptDetailed(script).actions;

  assert.deepEqual(parsed[0]?.positionals, ['start', './capture.mp4']);
  assert.equal(parsed[0]?.flags.fps, 24);
  assert.equal(parsed[0]?.flags.quality, 'high');
  assert.equal(parsed[0]?.flags.hideTouches, true);
});

// Parser-level witnesses of the retired `--max-size` refusal. The
// release-provenance frozen forms live in the replay-compat corpus
// (test/replay-compat/scripts/docs/{screenshot,record}-max-size.v0.20.5.ad);
// these fast unit copies pin the same behavior at the parse seam: refusal
// with migration guidance, never a silent degrade into extra positionals.
test('released screenshot --max-size lines are refused with migration guidance', () => {
  assert.throws(() => parseReplayScriptDetailed('screenshot "./page.png" --max-size 1024\n'), {
    code: 'INVALID_ARGS',
    message: /screenshot --max-size was removed; use --scale/,
  });
});

test('released record --max-size lines are refused with migration guidance', () => {
  assert.throws(() => parseReplayScriptDetailed('record start "./capture.mp4" --max-size 1024\n'), {
    code: 'INVALID_ARGS',
    message: /record --max-size was removed/,
  });
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
        screenshotScale: 0.3,
        screenshotNoStabilize: true,
      },
    },
  ];

  const script = formatReplayScriptForTest(actions);
  assert.match(
    script,
    /screenshot "\.\/page\.png" --pixel-density 2 --fullscreen --scale 0.3 --no-stabilize/,
  );

  const parsed = parseReplayScriptDetailed(script).actions;
  assert.deepEqual(parsed[0]?.positionals, ['./page.png']);
  assert.equal(parsed[0]?.flags.screenshotPixelDensity, 2);
  assert.equal(parsed[0]?.flags.screenshotFullscreen, true);
  assert.equal(parsed[0]?.flags.screenshotScale, 0.3);
  assert.equal(parsed[0]?.flags.screenshotNoStabilize, true);
});

test('screenshot replay script round-trips a quoted --crop-on selector', () => {
  const actions: SessionAction[] = [
    {
      ts: Date.now(),
      command: 'screenshot',
      positionals: ['./page.png'],
      flags: {
        screenshotCropOn: 'role=cell label=General || role=button label=General',
        screenshotScale: 0.3,
      },
    },
  ];

  const script = formatReplayScriptForTest(actions);
  assert.match(
    script,
    /screenshot "\.\/page\.png" --crop-on "role=cell label=General \|\| role=button label=General" --scale 0\.3/,
  );

  const parsed = parseReplayScriptDetailed(script).actions;
  assert.deepEqual(parsed[0]?.positionals, ['./page.png']);
  assert.equal(
    parsed[0]?.flags.screenshotCropOn,
    'role=cell label=General || role=button label=General',
  );
  assert.equal(parsed[0]?.flags.screenshotScale, 0.3);
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

// #3197: reaching an off-screen element used to be CLI-only. `scroll --until` was
// invisible to the script grammar, so its tokens fell through as positionals and the
// daemon read `--until` as the scroll amount ("scroll amount must be a number").
test('scroll replay script parses the --until stop condition as a flag, not an amount', () => {
  const parsed = parseReplayScriptDetailed(
    String.raw`scroll down --until "id=\"far-button\""` + '\n',
  ).actions;

  assert.deepEqual(parsed[0]?.positionals, ['down']);
  assert.equal(parsed[0]?.flags.until, 'id="far-button"');
});

test('scroll replay script keeps an amount positional beside the stop condition', () => {
  const parsed = parseReplayScriptDetailed('scroll down 0.8 --until label=Email\n').actions;

  assert.deepEqual(parsed[0]?.positionals, ['down', '0.8']);
  assert.equal(parsed[0]?.flags.until, 'label=Email');
});

test('a scroll --until value with spaces survives as one selector when quoted', () => {
  const parsed = parseReplayScriptDetailed(
    String.raw`scroll down --until "label=\"Sign in\" || label=\"Log in\""`,
  ).actions;

  assert.equal(parsed[0]?.flags.until, 'label="Sign in" || label="Log in"');
});

test('scroll replay script writes its stop condition back where the parser reads it', () => {
  const actions: SessionAction[] = [
    {
      ts: Date.now(),
      command: 'scroll',
      positionals: ['down', '0.8'],
      flags: { until: 'label="Sign in"' },
    },
  ];

  const script = formatReplayScriptForTest(actions);

  // The generic writer quotes a non-`@` positional as a JSON literal (pre-existing
  // for every generic line); the parser reads either spelling back.
  assert.match(script, /scroll "down" 0\.8 --until "label=\\"Sign in\\""/);
  const reparsed = parseReplayScriptDetailed(script).actions[0];
  assert.deepEqual(reparsed?.positionals, ['down', '0.8']);
  assert.deepEqual(reparsed?.flags, { until: 'label="Sign in"' });
});

// The other half of #3197: `--raw`, `--depth`, and `--scope` are declared on `wait`
// (`SELECTOR_SNAPSHOT_FLAGS`) and recorded, but a script line put them INSIDE the
// positional list, where the wait parser refused the line as selector-shaped text.
test('wait replay script parses its capture-scope flags out of the positionals', () => {
  const parsed = parseReplayScriptDetailed(
    [
      'wait id="x" --raw',
      'wait --raw label=Email',
      String.raw`wait "label=\"Sign in\"" --scope "@e3" --depth 2`,
      'wait "label=Checkout" 5000 --raw',
    ].join('\n') + '\n',
  ).actions;

  assert.deepEqual(parsed[0]?.positionals, ['id="x"']);
  assert.equal(parsed[0]?.flags.snapshotRaw, true);
  assert.deepEqual(parsed[1]?.positionals, ['label=Email']);
  assert.equal(parsed[1]?.flags.snapshotRaw, true);
  assert.deepEqual(parsed[2]?.positionals, ['label="Sign in"']);
  assert.equal(parsed[2]?.flags.snapshotScope, '@e3');
  assert.equal(parsed[2]?.flags.snapshotDepth, 2);
  // The budget positional and a capture flag compose in either written order.
  assert.deepEqual(parsed[3]?.positionals, ['label=Checkout', '5000']);
  assert.equal(parsed[3]?.flags.snapshotRaw, true);
});

// The `-d`/`-s` CLI aliases stay OUT of the script grammar: pre-existing lines
// like `wait text -s so funny` meant the literal text, and a grammar that
// reclassified them would silently change a passing script's oracle. Recordings
// only ever write the long spelling.
test('wait keeps the -d/-s CLI aliases out of the script grammar', () => {
  const parsed = parseReplayScriptDetailed('wait text -d 2 hello world\n').actions;

  assert.deepEqual(parsed[0]?.positionals, ['text', '-d', '2', 'hello', 'world']);
  assert.equal(parsed[0]?.flags.snapshotDepth, undefined);
});

test('wait replay script writes its capture-scope flags back', () => {
  const actions: SessionAction[] = [
    {
      ts: Date.now(),
      command: 'wait',
      positionals: ['label=Email', '2000'],
      flags: { snapshotRaw: true, snapshotDepth: 3 },
    },
  ];

  const script = formatReplayScriptForTest(actions);

  assert.match(script, /wait "label=Email" 2000 --raw --depth 3/);
  const reparsed = parseReplayScriptDetailed(script).actions[0];
  assert.deepEqual(reparsed?.positionals, ['label=Email', '2000']);
  assert.equal(reparsed?.flags.snapshotRaw, true);
  assert.equal(reparsed?.flags.snapshotDepth, 3);
});

// The CLI hands a selector through the shell, whose single quotes strip to one
// argument; the same text in a `.ad` line split into fragments (#3197).
test('a single-quoted script token is one argument, with its double quotes intact', () => {
  const parsed = parseReplayScriptDetailed(
    ['press \'id="far-button"\'', 'wait \'label="Sign in"\' 2000'].join('\n') + '\n',
  ).actions;

  assert.deepEqual(parsed[0]?.positionals, ['id="far-button"']);
  assert.deepEqual(parsed[1]?.positionals, ['label="Sign in"', '2000']);
});

test('a single-quoted script token carries a --until selector with spaces', () => {
  const parsed = parseReplayScriptDetailed('scroll down --until \'label="Sign in"\'\n').actions;

  assert.equal(parsed[0]?.flags.until, 'label="Sign in"');
});

test('an apostrophe inside a bare token keeps its old meaning: no quote, no error', () => {
  // Only a token LEADING with `'` is a quoting candidate, so a value that merely
  // contains an apostrophe still parses as one bare token, as it always did.
  const parsed = parseReplayScriptDetailed("wait text it's fine\n").actions;

  assert.deepEqual(parsed[0]?.positionals, ['text', "it's", 'fine']);
});

test("a quote that stops mid-word stays the apostrophe it was, not the shell's split", () => {
  // The shell reads `'a b'c` as one glued argument. A script line has no second
  // reader for that reading, and re-tokenizing would change what a previously-valid
  // line means, so a closing quote that does not end the word keeps the old bare
  // split (`'a` + `b'c`) rather than inventing a third meaning.
  const parsed = parseReplayScriptDetailed("wait text 'a b'c\n").actions;

  assert.deepEqual(parsed[0]?.positionals, ['text', "'a", "b'c"]);
});

test('an unclosed single quote never turns a previously valid line into an error', () => {
  // A value with one stray apostrophe is not a quoted token; it parses as bare
  // tokens exactly as it did before single quotes were quoting characters.
  const parsed = parseReplayScriptDetailed("wait text don't\n").actions;

  assert.deepEqual(parsed[0]?.positionals, ['text', "don't"]);
});

test("single quotes carry an apostrophe through ', and a backslash stays itself", () => {
  // Shell parity: `agent-device wait 'label="don\'t"'` hands over the backslash-
  // apostrophe pair, so the script has to read the same selector. A shell keeps a
  // bare `\` inside single quotes, and so does the script line — including a `\\`
  // pair, which the superseded decoder collapsed to one backslash; this assertion
  // is what that regression would fail on.
  const parsed = parseReplayScriptDetailed(
    [
      String.raw`wait 'label="don\'t"'`,
      String.raw`snapshot --scope 'a\\b'`,
      String.raw`snapshot --scope 'root\.section'`,
    ].join('\n') + '\n',
  ).actions;

  assert.deepEqual(parsed[0]?.positionals, ['label="don\'t"']);
  assert.equal(parsed[1]?.flags.snapshotScope, String.raw`a\\b`);
  assert.equal(parsed[2]?.flags.snapshotScope, String.raw`root\.section`);
});

test('a quoted value ending in an even backslash run still closes', () => {
  // `wait 'C:\\temp\\'` is one path with literal backslashes, not an unclosed
  // quote: only an ODD run pairs with the quote as the apostrophe escape. The
  // consequence is that a value ending in ONE literal backslash does not close in
  // single quotes under this grammar (the `\'` escape owns that position); a
  // double-quoted JSON string is the spelling for that one value.
  const parsed = parseReplayScriptDetailed(String.raw`wait 'C:\\temp\\'` + '\n').actions;

  assert.deepEqual(parsed[0]?.positionals, [String.raw`C:\\temp\\`]);
});

test('apostrophes that survive decoding keep the old bare reading', () => {
  // The shell reads `'don't do this'` as three arguments. A script line has no
  // second reader to hand it to, so re-tokenizing would change what a
  // previously-valid line means; it stays one bare token run, as it always was.
  const parsed = parseReplayScriptDetailed("wait text 'don't do this'\n").actions;

  assert.deepEqual(parsed[0]?.positionals, ['text', "'don't", 'do', "this'"]);
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
  const header = `context platform=android device=${formatScriptStringLiteral(String.raw`Pixel "QA" \ Lab`)} kind=emulator theme=unknown`;
  assert.equal(
    header,
    String.raw`context platform=android device="Pixel \"QA\" \\ Lab" kind=emulator theme=unknown`,
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
      positionals: [String.raw`foo\nbar.png`],
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

  assert.match(script, /type " {2}leading\\ttrailing {2}"/);
  assert.match(script, /fill @e2 ""/);
  assert.match(script, /screenshot " \.\/screens\/final\.png "/);
  assert.match(script, /screenshot "foo\\\\nbar\.png"/);
  assert.match(script, /--metro-host " host\\t" --launch-url "myapp:\/\/dev "/);

  const parsed = parseReplayScriptDetailed(script).actions;
  assert.deepEqual(parsed[0]?.positionals, ['  leading\ttrailing  ']);
  assert.deepEqual(parsed[1]?.positionals, ['@e2', '']);
  assert.deepEqual(parsed[2]?.positionals, [' ./screens/final.png ']);
  assert.deepEqual(parsed[3]?.positionals, [String.raw`foo\nbar.png`]);
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
    'harmonyos',
    'ios',
    'linux',
    'macos',
    'vega',
  ]);
});

test('readReplayScriptMetadata accepts every concrete leaf platform', () => {
  for (const platform of ['ios', 'android', 'harmonyos', 'vega', 'macos', 'linux'] as const) {
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

test('a targets-v1 annotation binds both drag endpoints to one action', () => {
  const source = { ...SAVE_EVIDENCE, id: 'source', label: 'Source' };
  const destination = { ...SAVE_EVIDENCE, id: 'destination', label: 'Destination' };
  const script = [
    `# agent-device:targets-v1 ${JSON.stringify({ source, destination })}`,
    'gesture drag id="source" id="destination" 800 500 0',
  ].join('\n');
  const action = parseReplayScriptDetailed(script).actions[0];
  assert.deepEqual(action?.targetEvidences, { source, destination });
  assert.equal(action?.targetEvidence, undefined);
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
  ['invalid escape', String.raw`fill @e1 --text "hello wor\ld"`],
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
    String.raw`fill "label=\"Email\"" <text>`,
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
    String.raw`click "label=\"Save\""`,
  );
});

// The property test asserting "serializing a parsed script is a fixed point
// for generated scripts" stays at `src/commands/replay/ad-script-round-trip.test.ts`:
// its script generator (`replayScriptArb`) is derived from the root command
// catalog and selector grammar (`src/__tests__/test-utils/property-arbitraries.ts`),
// which this package cannot import without an R11 package→root-src escape
// (#1478 P5 scoping dossier §5d). It exercises this package's exports via
// the `@agent-device/ad-script` specifier instead of duplicating the codec.
