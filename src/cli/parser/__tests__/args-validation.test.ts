import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseArgs } from '../args.ts';
import { AppError } from '@agent-device/kernel/errors';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import { getCliCommandSchema } from '@agent-device/command-surface';

test('parseArgs rejects test retries above the supported ceiling', () => {
  assert.throws(
    () => parseArgs(['test', './suite', '--retries', '4'], { strictFlags: true }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Invalid retries: 4/.test(error.message),
  );
});

test('parseArgs rejects --launch-args on commands that do not allow it', () => {
  assert.throws(
    () => parseArgs(['tap', '100', '200', '--launch-args', 'foo'], { strictFlags: true }),
    (error) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('parseArgs rejects invalid record --fps range', () => {
  assert.throws(
    () => parseArgs(['record', 'start', './capture.mp4', '--fps', '0'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message ===
        'Invalid fps: 0. Expected number from 1 to 120 (rounded down to an integer).',
  );
});

test('parseArgs names the accepted values of a refused flag value', () => {
  const cases: Array<[string[], Record<string, unknown>, string]> = [
    [
      ['open', 'com.example.app', '--wait', '240000'],
      { flag: '--wait', min: 100, max: 120000 },
      'Expected number from 100 to 120000 (rounded down to an integer).',
    ],
    [
      ['open', 'com.example.app', '--wait=soon'],
      { flag: '--wait', min: 100, max: 120000 },
      'Expected number from 100 to 120000 (rounded down to an integer).',
    ],
    [
      ['open', 'com.example.app', '--timeout', '0.5'],
      { flag: '--timeout', min: 1, max: undefined },
      'Expected number >= 1 (rounded down to an integer).',
    ],
    [
      ['screenshot', './shot.png', '--scale', '2'],
      { flag: '--scale', min: 0.01, max: 1 },
      'Expected number from 0.01 to 1.',
    ],
    [
      ['snapshot', '--target', 'watch'],
      { flag: '--target', allowed: ['mobile', 'tv', 'desktop'] },
      'Expected one of: mobile, tv, desktop.',
    ],
  ];

  for (const [argv, bounds, expected] of cases) {
    assert.throws(
      () => parseArgs(argv, { strictFlags: true }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.deepEqual(error.details, { reason: 'flag_value_invalid', ...bounds });
        assert.ok(error.message.endsWith(expected), error.message);
        return true;
      },
      `expected ${argv.join(' ')} to be refused with its accepted values`,
    );
  }
});

test('parseArgs floors an in-range fractional value of an integer flag', () => {
  const parsed = parseArgs(['open', 'com.example.app', '--timeout', '1.5'], { strictFlags: true });
  assert.equal(parsed.flags.timeoutMs, 1);
});

test('parseArgs refuses a record option the chosen action never reads', () => {
  const cases: Array<[string[], string]> = [
    [
      ['record', 'start', './capture.mp4', '--out', './elsewhere.mp4'],
      'record start does not read --out',
    ],
    [['record', 'stop', '--fps', '30'], 'record stop does not read --fps'],
    [['record', 'stop', '--hide-touches'], 'record stop does not read --hide-touches'],
    [
      ['record', 'contact-sheet', './clip.mp4', '--fps', '30'],
      'record contact-sheet does not read --fps',
    ],
  ];

  for (const [argv, message] of cases) {
    assert.throws(
      () => parseArgs(argv, { strictFlags: true }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message.startsWith(message),
      `expected ${argv.join(' ')} to be refused`,
    );
  }
});

test('parseArgs accepts the options each record action reads', () => {
  const cases: string[][] = [
    ['record', 'start', './capture.mp4', '--fps', '30', '--quality', 'high', '--hide-touches'],
    ['record', 'stop'],
    ['record', 'contact-sheet', './clip.mp4', '--out', './sheet.png'],
  ];

  for (const argv of cases) {
    assert.doesNotThrow(() => parseArgs(argv, { strictFlags: true }), `expected ${argv.join(' ')}`);
  }
});

test('parseArgs refuses an option the selected action of a command never reads', () => {
  const cases: Array<[string[], string]> = [
    [['diff', 'snapshot', '--baseline', './base.png'], 'diff snapshot does not read --baseline'],
    [
      ['diff', 'screenshot', '--baseline', './base.png', '--depth', '3'],
      'diff screenshot does not read --depth',
    ],
    [
      ['perf', 'cpu', 'profile', 'stop', '--kind', 'xctrace', '--template', 'Time Profiler'],
      'perf cpu profile stop does not read --template',
    ],
    [['perf', 'frames', '--template', 'Time Profiler'], 'perf frames does not read --template'],
    [['metro', 'reload', '--project-root', './app'], 'metro reload does not read --project-root'],
    [['logs', 'path', '--restart'], 'logs path does not read --restart'],
    [['session', 'list', '--force'], 'session list does not read --force'],
  ];

  for (const [argv, message] of cases) {
    assert.throws(
      () => parseArgs(argv, { strictFlags: true }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message.startsWith(message),
      `expected ${argv.join(' ')} to be refused`,
    );
  }
});

test('parseArgs accepts the options the selected action of a command reads', () => {
  const cases: string[][] = [
    ['diff', 'snapshot', '-i', '--depth', '3', '--raw'],
    ['diff', 'screenshot', '--baseline', './base.png', '--out', './diff.png', '--threshold', '0.2'],
    'perf cpu profile start --kind xctrace --template Profiler --out ./app.trace'.split(' '),
    ['perf', 'cpu', 'profile', 'stop', '--kind', 'xctrace', '--out', './app.trace'],
    ['metro', 'reload', '--metro-port', '8082', '--probe-timeout-ms', '5000'],
    ['logs', 'clear', '--restart'],
    ['session', 'save-script', './flow.ad', '--force'],
  ];

  for (const argv of cases) {
    assert.doesNotThrow(() => parseArgs(argv, { strictFlags: true }), `expected ${argv.join(' ')}`);
  }
});

test('parseArgs leaves an option every action reads to the command itself', () => {
  // --json and --no-record are read whatever action follows the command name, so an action table that
  // does not list them must not turn them into unread options.
  for (const argv of [
    ['record', 'stop', '--json'],
    ['record', 'contact-sheet', './clip.mp4', '--no-record'],
  ]) {
    assert.doesNotThrow(() => parseArgs(argv, { strictFlags: true }), `expected ${argv.join(' ')}`);
  }
});

test('parseArgs leaves a command without an action table to its own validation', () => {
  // `network` declares no action option table at all, and `record nonsense` names an action the record
  // table never lists. Neither may be refused as an unread option here: the first is validated by its
  // own command, and an action the table does not list belongs to the reader that owns the action list.
  assert.doesNotThrow(() =>
    parseArgs(['network', 'dump', '--include', 'all'], { strictFlags: true }),
  );
  assert.doesNotThrow(() =>
    parseArgs(['record', 'nonsense', '--fps', '30'], { strictFlags: true }),
  );
});

test('parseArgs rejects invalid swipe pattern', () => {
  assert.throws(
    () => parseArgs(['swipe', '0', '0', '10', '10', '--pattern', 'diagonal']),
    /Invalid pattern/,
  );
});

test('parseArgs rejects conflicting back mode flags', () => {
  assert.throws(
    () => parseArgs(['back', '--in-app', '--system'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message ===
        'back accepts only one explicit mode flag: use either --in-app or --system.',
  );
});

test('debug rejects unrelated diagnostics flags', () => {
  assert.throws(
    () => parseArgs(['debug', 'symbols', '--include', 'headers']),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('not supported for command debug'),
  );
});

test('compat mode warns and strips unsupported command flags', () => {
  const parsed = parseArgs(['press', '10', '20', '--pause-ms', '2'], { strictFlags: false });
  assert.equal(parsed.command, 'press');
  assert.equal(parsed.flags.pauseMs, undefined);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0]!, /not supported for command press/);
});

test('strict mode rejects unsupported pilot-command flags', () => {
  assert.throws(
    () => parseArgs(['press', '10', '20', '--pause-ms', '2'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('not supported for command press'),
  );
});

test('strict mode rejects Metro override flags on doctor', () => {
  assert.throws(
    () => parseArgs(['doctor', '--metro-port', '9090'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('not supported for command doctor'),
  );
});

test('strict mode rejects removed secondary alias', () => {
  assert.throws(
    () => parseArgs(['click', '@e5', '--secondary'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown flag: --secondary',
  );
});

test('strict mode rejects click-only button flag on press', () => {
  assert.throws(
    () => parseArgs(['press', '10', '20', '--button', 'secondary'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('not supported for command press'),
  );
});

test('unknown short flags are rejected', () => {
  assert.throws(
    () => parseArgs(['press', '10', '20', '-x'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown flag: -x',
  );
});

test('negative numeric positionals are accepted without -- separator', () => {
  const typed = parseArgs(['type', '-123'], { strictFlags: true });
  assert.equal(typed.command, 'type');
  assert.deepEqual(typed.positionals, ['-123']);

  const typedMulti = parseArgs(['type', '-123', '-456'], { strictFlags: true });
  assert.equal(typedMulti.command, 'type');
  assert.deepEqual(typedMulti.positionals, ['-123', '-456']);

  const pressed = parseArgs(['press', '-10', '20'], { strictFlags: true });
  assert.equal(pressed.command, 'press');
  assert.deepEqual(pressed.positionals, ['-10', '20']);
});

test('get accepts a snapshot ref with a multiword label', () => {
  const parsed = parseArgs(['get', 'text', '@e5~s3', 'World', 'Clock'], { strictFlags: true });

  assert.equal(parsed.command, 'get');
  assert.deepEqual(parsed.positionals, ['text', '@e5~s3', 'World', 'Clock']);
});

test('bounded commands reject excess positionals from their CLI schema', () => {
  for (const command of listCliCommandNames()) {
    const schema = getCliCommandSchema(command);
    if (schema.allowsExtraPositionals) continue;
    const maximum = schema.positionalArgs?.length ?? 0;
    const positionals = Array.from({ length: maximum + 1 }, (_, index) => `arg-${index + 1}`);

    assert.throws(
      () => parseArgs([command, ...positionals], { strictFlags: true }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message ===
          `${command} accepts at most ${maximum} positional argument(s), received ${positionals.length}: ${positionals.join(' ')}`,
      `Expected ${command} to reject excess positionals`,
    );
  }
});

test('command-specific flags without command fail in strict mode', () => {
  assert.throws(
    () => parseArgs(['--depth', '3'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('requires a command that supports it'),
  );
});

test('command-specific flags without command warn and strip in compat mode', () => {
  const parsed = parseArgs(['--depth', '3'], { strictFlags: false });
  assert.equal(parsed.command, null);
  assert.equal(parsed.flags.snapshotDepth, undefined);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0]!, /requires a command that supports/);
});

test('all commands participate in strict command-flag validation', () => {
  assert.throws(
    () => parseArgs(['open', 'Settings', '--depth', '1'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('not supported for command open'),
  );
});

test('invalid range errors are deterministic', () => {
  assert.throws(
    () => parseArgs(['snapshot', '--backend', 'xctest'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown flag: --backend',
  );
  assert.throws(
    () => parseArgs(['snapshot', '--depth', '-1'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Invalid depth: -1. Expected number >= 0 (rounded down to an integer).',
  );
});

test('parseArgs rejects an empty numeric flag value instead of reading it as 0', () => {
  for (const argv of [
    ['test', './suite', '--retries='],
    ['test', './suite', '--retries', ''],
    ['test', './suite', '--retries', ' '],
  ]) {
    assert.throws(
      () => parseArgs(argv, { strictFlags: true }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message === 'Flag --retries requires a value.',
      `expected ${JSON.stringify(argv)} to be refused`,
    );
  }
});
