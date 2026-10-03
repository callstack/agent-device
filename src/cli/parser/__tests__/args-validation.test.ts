import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseArgs } from '../args.ts';
import { AppError } from '@agent-device/kernel/errors';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import { getCliCommandSchema } from '../../../commands/schema/command-schema.ts';

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
      error.message === 'Invalid fps: 0',
  );
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
  // `perf` declares no action option table at all, and `record nonsense` names an action the record
  // table never lists. Neither may be refused as an unread option here: the first is validated by its
  // own command, and an action the table does not list belongs to the reader that owns the action list.
  assert.doesNotThrow(() => parseArgs(['perf', 'start', './perf.json'], { strictFlags: true }));
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
      error.message === 'Invalid depth: -1',
  );
});
