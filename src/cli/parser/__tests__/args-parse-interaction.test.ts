import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseArgs } from '../args.ts';

test('parseArgs accepts clipboard subcommands', () => {
  const read = parseArgs(['clipboard', 'read'], { strictFlags: true });
  assert.equal(read.command, 'clipboard');
  assert.deepEqual(read.positionals, ['read']);

  const write = parseArgs(['clipboard', 'write', 'otp', '123456'], { strictFlags: true });
  assert.equal(write.command, 'clipboard');
  assert.deepEqual(write.positionals, ['write', 'otp', '123456']);
});

test('parseArgs accepts keyboard subcommands', () => {
  const status = parseArgs(['keyboard', 'status'], { strictFlags: true });
  assert.equal(status.command, 'keyboard');
  assert.deepEqual(status.positionals, ['status']);

  const dismiss = parseArgs(['keyboard', 'dismiss'], { strictFlags: true });
  assert.equal(dismiss.command, 'keyboard');
  assert.deepEqual(dismiss.positionals, ['dismiss']);

  const enter = parseArgs(['keyboard', 'enter'], { strictFlags: true });
  assert.equal(enter.command, 'keyboard');
  assert.deepEqual(enter.positionals, ['enter']);
});

test('parseArgs accepts scroll pixel distance and duration flags', () => {
  const parsed = parseArgs(['scroll', 'down', '--pixels', '240', '--duration-ms', '50'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'scroll');
  assert.deepEqual(parsed.positionals, ['down']);
  assert.equal(parsed.flags.pixels, 240);
  assert.equal(parsed.flags.durationMs, 50);
});

test('parseArgs keeps no-record accepted on recordable commands', () => {
  const press = parseArgs(['press', '10', '10', '--no-record'], { strictFlags: true });
  assert.equal(press.flags.noRecord, true);

  const swipe = parseArgs(['swipe', '0', '0', '10', '10', '--no-record'], {
    strictFlags: true,
  });
  assert.equal(swipe.flags.noRecord, true);
});

test('parseArgs recognizes press series flags', () => {
  const parsed = parseArgs([
    'press',
    '300',
    '500',
    '--count',
    '12',
    '--interval-ms=45',
    '--hold-ms',
    '120',
    '--jitter-px',
    '3',
  ]);
  assert.equal(parsed.command, 'press');
  assert.deepEqual(parsed.positionals, ['300', '500']);
  assert.equal(parsed.flags.count, 12);
  assert.equal(parsed.flags.intervalMs, 45);
  assert.equal(parsed.flags.holdMs, 120);
  assert.equal(parsed.flags.jitterPx, 3);
});

test('parseArgs recognizes press selector + snapshot flags', () => {
  const parsed = parseArgs(['press', '@e2', '--depth', '3', '--scope', 'Sign In', '--raw'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'press');
  assert.deepEqual(parsed.positionals, ['@e2']);
  assert.equal(parsed.flags.snapshotDepth, 3);
  assert.equal(parsed.flags.snapshotScope, 'Sign In');
  assert.equal(parsed.flags.snapshotRaw, true);
});

test('parseArgs recognizes click series flags', () => {
  const parsed = parseArgs(['click', '@e5', '--count', '4', '--interval-ms', '10'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'click');
  assert.deepEqual(parsed.positionals, ['@e5']);
  assert.equal(parsed.flags.count, 4);
  assert.equal(parsed.flags.intervalMs, 10);
});

test('parseArgs recognizes click button flag', () => {
  const parsed = parseArgs(['click', '@e5', '--button', 'secondary'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'click');
  assert.deepEqual(parsed.positionals, ['@e5']);
  assert.equal(parsed.flags.clickButton, 'secondary');
});

test('parseArgs recognizes double-tap flag for repeated press', () => {
  const parsed = parseArgs(['press', '201', '545', '--count', '5', '--double-tap'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'press');
  assert.deepEqual(parsed.positionals, ['201', '545']);
  assert.equal(parsed.flags.count, 5);
  assert.equal(parsed.flags.doubleTap, true);
});

test('parseArgs recognizes swipe positional + pattern flags', () => {
  const parsed = parseArgs([
    'swipe',
    '540',
    '1500',
    '540',
    '500',
    '120',
    '--count',
    '8',
    '--pause-ms',
    '30',
    '--pattern',
    'ping-pong',
  ]);
  assert.equal(parsed.command, 'swipe');
  assert.deepEqual(parsed.positionals, ['540', '1500', '540', '500', '120']);
  assert.equal(parsed.flags.count, 8);
  assert.equal(parsed.flags.pauseMs, 30);
  assert.equal(parsed.flags.pattern, 'ping-pong');
});

test('parseArgs recognizes gesture subcommand positionals', () => {
  const pan = parseArgs(['gesture', 'pan', '200', '420', '0', '-80', '500'], {
    strictFlags: true,
  });
  assert.equal(pan.command, 'gesture');
  assert.deepEqual(pan.positionals, ['pan', '200', '420', '0', '-80', '500']);

  const fling = parseArgs(['gesture', 'fling', 'right', '200', '420', '180'], {
    strictFlags: true,
  });
  assert.equal(fling.command, 'gesture');
  assert.deepEqual(fling.positionals, ['fling', 'right', '200', '420', '180']);

  const rotate = parseArgs(['gesture', 'rotate', '35', '200', '420'], {
    strictFlags: true,
  });
  assert.equal(rotate.command, 'gesture');
  assert.deepEqual(rotate.positionals, ['rotate', '35', '200', '420']);

  const transform = parseArgs(['gesture', 'transform', '200', '420', '80', '-40', '2', '35'], {
    strictFlags: true,
  });
  assert.equal(transform.command, 'gesture');
  assert.deepEqual(transform.positionals, ['transform', '200', '420', '80', '-40', '2', '35']);
});

test('parseArgs recognizes type and fill delay flags', () => {
  const typeParsed = parseArgs(['type', 'hello', '--delay-ms', '75'], {
    strictFlags: true,
  });
  assert.equal(typeParsed.command, 'type');
  assert.deepEqual(typeParsed.positionals, ['hello']);
  assert.equal(typeParsed.flags.delayMs, 75);

  const fillParsed = parseArgs(['fill', '@e5', 'search', '--delay-ms', '40'], {
    strictFlags: true,
  });
  assert.equal(fillParsed.command, 'fill');
  assert.deepEqual(fillParsed.positionals, ['@e5', 'search']);
  assert.equal(fillParsed.flags.delayMs, 40);
});

test('parseArgs recognizes record --fps flag', () => {
  const parsed = parseArgs(['record', 'start', './capture.mp4', '--fps', '30'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'record');
  assert.deepEqual(parsed.positionals, ['start', './capture.mp4']);
  assert.equal(parsed.flags.fps, 30);
});

test('parseArgs recognizes record --quality flag', () => {
  const parsed = parseArgs(['record', 'start', './capture.mp4', '--quality', 'high'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'record');
  assert.deepEqual(parsed.positionals, ['start', './capture.mp4']);
  assert.equal(parsed.flags.quality, 'high');
});

test('parseArgs recognizes record --max-size flag', () => {
  const parsed = parseArgs(['record', 'start', './capture.mp4', '--max-size', '1024'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'record');
  assert.deepEqual(parsed.positionals, ['start', './capture.mp4']);
  assert.equal(parsed.flags.screenshotMaxSize, 1024);
});

test('parseArgs recognizes record --hide-touches flag', () => {
  const parsed = parseArgs(['record', 'start', './capture.mp4', '--hide-touches'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'record');
  assert.deepEqual(parsed.positionals, ['start', './capture.mp4']);
  assert.equal(parsed.flags.hideTouches, true);
});

test('parseArgs recognizes screenshot flags', () => {
  const parsed = parseArgs(
    [
      'screenshot',
      'page.png',
      '--full',
      '-f',
      '--fullscreen',
      '--max-size',
      '1024',
      '--no-stabilize',
      '--normalize-status-bar',
    ],
    {
      strictFlags: true,
    },
  );
  assert.equal(parsed.command, 'screenshot');
  assert.deepEqual(parsed.positionals, ['page.png']);
  assert.equal(parsed.flags.screenshotFullscreen, true);
  assert.equal(parsed.flags.screenshotMaxSize, 1024);
  assert.equal(parsed.flags.screenshotNoStabilize, true);
  assert.equal(parsed.flags.screenshotNormalizeStatusBar, true);
});

test('parseArgs recognizes viewport command', () => {
  const parsed = parseArgs(['viewport', '1280', '900', '--platform', 'web'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'viewport');
  assert.deepEqual(parsed.positionals, ['1280', '900']);
  assert.equal(parsed.flags.platform, 'web');
});

test('parseArgs recognizes longpress command', () => {
  const parsed = parseArgs(['longpress', '300', '500', '800'], { strictFlags: true });
  assert.equal(parsed.command, 'longpress');
  assert.deepEqual(parsed.positionals, ['300', '500', '800']);
});

test('parseArgs supports legacy long-press alias', () => {
  const parsed = parseArgs(['long-press', '300', '500', '800'], { strictFlags: true });
  assert.equal(parsed.command, 'longpress');
  assert.deepEqual(parsed.positionals, ['300', '500', '800']);
});

test('parseArgs supports tap alias for press', () => {
  const parsed = parseArgs(['tap', '@e3'], { strictFlags: true });
  assert.equal(parsed.command, 'press');
  assert.deepEqual(parsed.positionals, ['@e3']);
});

test('parseArgs preserves flags when tap is aliased to press', () => {
  const parsed = parseArgs(['tap', '@e3', '--json'], { strictFlags: true });
  assert.equal(parsed.command, 'press');
  assert.deepEqual(parsed.positionals, ['@e3']);
  assert.equal(parsed.flags.json, true);
});

test('parseArgs supports trigger-app-event payload argument', () => {
  const parsed = parseArgs(['trigger-app-event', 'screenshot_taken', '{"source":"qa"}'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'trigger-app-event');
  assert.deepEqual(parsed.positionals, ['screenshot_taken', '{"source":"qa"}']);
});

test('parseArgs accepts rotate orientation aliases', () => {
  const parsed = parseArgs(['rotate', 'left'], { strictFlags: true });
  assert.equal(parsed.command, 'rotate');
  assert.deepEqual(parsed.positionals, ['left']);
});

test('parseArgs recognizes test --record-video flag', () => {
  const parsed = parseArgs(['test', './suite', '--record-video'], { strictFlags: true });
  assert.equal(parsed.command, 'test');
  assert.equal(parsed.flags.recordVideo, true);
});

test('snapshot command accepts command-specific flags', () => {
  const ignoredLegacyFlag = '-' + 'c';
  const parsed = parseArgs(
    ['snapshot', '-i', ignoredLegacyFlag, '--depth', '3', '-s', 'Login', '--timeout', '120000'],
    {
      strictFlags: true,
    },
  );
  assert.equal(parsed.command, 'snapshot');
  assert.equal(parsed.flags.snapshotInteractiveOnly, true);
  assert.equal(parsed.flags.snapshotDepth, 3);
  assert.equal(parsed.flags.snapshotScope, 'Login');
  assert.equal(parsed.flags.timeoutMs, 120000);
});

test('snapshot command accepts diff alias flag', () => {
  const parsed = parseArgs(['snapshot', '--diff', '-i', '--depth', '4', '--scope', 'Counter'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'diff');
  assert.deepEqual(parsed.positionals, ['snapshot']);
  assert.equal(parsed.flags.snapshotDiff, undefined);
  assert.equal(parsed.flags.snapshotInteractiveOnly, true);
  assert.equal(parsed.flags.snapshotDepth, 4);
  assert.equal(parsed.flags.snapshotScope, 'Counter');
});

test('snapshot --diff --help stays on snapshot command help', () => {
  const parsed = parseArgs(['snapshot', '--diff', '--help'], { strictFlags: true });
  assert.equal(parsed.command, 'snapshot');
  assert.equal(parsed.flags.snapshotDiff, true);
  assert.equal(parsed.flags.help, true);
});

test('diff snapshot command accepts snapshot flags', () => {
  const parsed = parseArgs(
    ['diff', 'snapshot', '-i', '--depth', '4', '--scope', 'Counter', '--raw'],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'diff');
  assert.deepEqual(parsed.positionals, ['snapshot']);
  assert.equal(parsed.flags.snapshotInteractiveOnly, true);
  assert.equal(parsed.flags.snapshotDepth, 4);
  assert.equal(parsed.flags.snapshotScope, 'Counter');
  assert.equal(parsed.flags.snapshotRaw, true);
});
