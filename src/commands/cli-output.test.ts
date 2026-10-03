import { describe, expect, test } from 'vitest';
import {
  listCommandFamilyCliOutputFormatters,
  listCommandFamilyMetadata,
} from './family/registry.ts';
import { formatCliOutput, isParseableOutputCommand } from './cli-output.ts';
import type { CommandName } from './command-metadata.ts';

/**
 * #2682: one dispatcher, one warning rule. Every command that renders text owes the agent the
 * response's `Warning:` lines, and the ONLY way a command keeps them off stdout is the
 * `parseableOutput` trait on its own descriptor, because its stdout is the value a caller pipes.
 * A command added tomorrow inherits the rule; a command that wants out has to say so here.
 */
const REPAIR_WARNING =
  'The session app was not foreground when this command arrived (prior state runningBackground), ' +
  'so the runner activated it before answering (reason stale_target).';

const PARSEABLE_OUTPUT_COMMANDS = [
  'clipboard',
  'find',
  'get',
  'record',
] as const satisfies readonly CommandName[];

/** Every command the registry gives a text formatter — the population the rule must cover. */
const FORMATTER_COMMANDS = Object.keys(
  listCommandFamilyCliOutputFormatters(),
).sort() as CommandName[];

async function render(name: CommandName, result: unknown, input = {}) {
  const output = await formatCliOutput({ name, input, result });
  expect(output, `${name} renders no CLI output`).toBeDefined();
  return output!;
}

/**
 * The table: what each formatter owes, asserted against every formatter the registry exposes. Each
 * payload is the shape that command's response really has, so a formatter cannot pass by ignoring a
 * synthetic one. `apps`/`devices` answer with a bare array, which is why they are marked `warns:
 * false`: the daemon has no warnings channel onto an array payload — a fact the table names instead
 * of hiding behind a skipped assertion.
 */
const RESPONSE_FIXTURES: Partial<Record<CommandName, unknown>> = {
  apps: ['com.example.app'],
  artifacts: { source: 'daemon', artifacts: [], message: 'No daemon artifacts.' },
  batch: { executed: 0, total: 0, totalDurationMs: 5, results: [] },
  capabilities: { device: { name: 'iPhone' }, availableCommands: [] },
  debug: {
    outPath: '/tmp/debug.crash',
    message: 'Crash read',
    crash: { topFrames: [], findings: [] },
    matchedImages: [],
  },
  devices: [],
  session: { sessions: [] },
};

type RenderCase = { name: CommandName; response: unknown; warns: boolean };

const RENDER_CASES: RenderCase[] = FORMATTER_COMMANDS.map((name) => {
  const fixture = RESPONSE_FIXTURES[name] ?? { message: 'done' };
  return {
    name,
    response: Array.isArray(fixture) ? fixture : { ...fixture, warnings: [REPAIR_WARNING] },
    warns: !Array.isArray(fixture),
  };
});

test('the parseable-output set is exactly the declared exceptions', () => {
  expect(FORMATTER_COMMANDS.filter(isParseableOutputCommand)).toEqual(
    [...PARSEABLE_OUTPUT_COMMANDS].sort(),
  );
});

/**
 * The commands with no formatter answer through the CLI's generic path, which routes the same way.
 * None of them may declare `parseableOutput`, because that path has no second stream to split — if
 * one ever does, it owes its own printer instead of silently losing the disclosure.
 */
test('a command with no formatter never opts out of stdout', () => {
  const allCommands = listCommandFamilyMetadata().map((metadata) => metadata.name);
  const withoutFormatter = allCommands.filter((name) => !FORMATTER_COMMANDS.includes(name));
  expect(withoutFormatter.length).toBeGreaterThan(0);
  expect(withoutFormatter.filter(isParseableOutputCommand)).toEqual([]);
});

describe('the dispatcher appends the response warnings for every formatter', () => {
  for (const testCase of RENDER_CASES) {
    const parseable = (PARSEABLE_OUTPUT_COMMANDS as readonly string[]).includes(testCase.name);
    const outcome = parseable
      ? 'keeps stdout as the value and warns on stderr'
      : testCase.warns
        ? 'warns on stdout'
        : 'has no warnings channel on its array payload';
    test(`${testCase.name} ${outcome}`, async () => {
      const output = await render(testCase.name, testCase.response as Record<string, unknown>);
      if (!testCase.warns) {
        expect(output.stderr ?? '').not.toContain(REPAIR_WARNING);
        return;
      }
      if (parseable) {
        expect(output.text ?? '').not.toContain(REPAIR_WARNING);
        expect(output.stderr ?? '').toContain(`Warning: ${REPAIR_WARNING}`);
      } else {
        // A report builder may already print the warning inside its own report; what no command may
        // do is drop it, or put it on a stream its reader is not watching.
        expect(output.text ?? '').toContain(REPAIR_WARNING);
        expect(output.stderr ?? '').not.toContain(REPAIR_WARNING);
      }
    });
  }
});

/**
 * A real reachable `get text` request: the CLI reader always produces `format`, so this is the input
 * the formatter actually receives after a capture repaired foreground. stdout stays the value a
 * caller can pipe; the disclosure is still there, on stderr, exactly once.
 */
describe('get text after a foreground repair', () => {
  const repaired = {
    text: 'General',
    node: { type: 'Cell', label: 'General' },
    warnings: [REPAIR_WARNING],
  };

  test('format text prints the value alone and warns once on stderr', async () => {
    const output = await render('get', repaired, { format: 'text', target: { ref: '@e1' } });
    expect(output.text).toBe('General');
    expect(output.stderr).toBe(`Warning: ${REPAIR_WARNING}\n`);
  });

  test('format attrs keeps its JSON parseable and warns once on stderr', async () => {
    const output = await render('get', repaired, { format: 'attrs', target: { ref: '@e1' } });
    expect(() => JSON.parse(String(output.text))).not.toThrow();
    expect(String(output.stderr?.match(/Warning:/g)?.length)).toBe('1');
  });

  test('a read that repaired nothing stays silent on both streams', async () => {
    const output = await render(
      'get',
      { text: 'General' },
      { format: 'text', target: { ref: '@e1' } },
    );
    expect(output.text).toBe('General');
    expect(output.stderr).toBeUndefined();
  });
});

/**
 * `find` shares `get`'s stdout rule, which is why `find <x> get text` and `get text` agree, while the
 * narration commands (`is`, `wait`) keep the warning on stdout after their own line.
 */
describe('the two stdout contracts in one run', () => {
  test('find get text keeps the value on stdout like get text does', async () => {
    const output = await render(
      'find',
      { text: 'General', warnings: [REPAIR_WARNING] },
      { query: 'General' },
    );
    expect(output.text).toBe('General');
    expect(output.stderr).toContain(`Warning: ${REPAIR_WARNING}`);
  });

  test('is prints the disclosure after its verdict on stdout', async () => {
    const output = await render(
      'is',
      { predicate: 'visible', result: true, warnings: [REPAIR_WARNING] },
      {
        predicate: 'visible',
        selector: 'label="General"',
      },
    );
    expect(output.text).toBe(`Passed: is visible\nWarning: ${REPAIR_WARNING}`);
  });

  test('press keeps an Android permission-dialog warning on stdout after its tap line', async () => {
    const permissionWarning =
      'press id="request-mic" opened an Android permission dialog ' +
      '(com.google.android.permissioncontroller) over com.example.app.';
    const output = await render('press', {
      message: 'Tapped (278, 817)',
      x: 278,
      y: 817,
      warning: permissionWarning,
    });
    expect(output.text).toBe(`Tapped (278, 817)\nWarning: ${permissionWarning}`);
  });

  test('wait prints the disclosure after its own line on stdout', async () => {
    const output = await render('wait', {
      message: 'Text "Receipt" appeared',
      warnings: [REPAIR_WARNING],
    });
    expect(output.text).toBe(`Text "Receipt" appeared\nWarning: ${REPAIR_WARNING}`);
  });

  test('press keeps its settle notes and gains the disclosure once', async () => {
    const output = await render('press', {
      message: 'Tapped (10, 20)',
      x: 10,
      y: 20,
      warnings: [REPAIR_WARNING],
      settle: { settled: true, waitedMs: 400, diff: { summary: { additions: 1, removals: 0 } } },
    });
    expect(output.text).toBe(
      [
        'Tapped (10, 20)',
        'settled after 400ms: +1 -0 (~0 unchanged)',
        `Warning: ${REPAIR_WARNING}`,
      ].join('\n'),
    );
  });
});
