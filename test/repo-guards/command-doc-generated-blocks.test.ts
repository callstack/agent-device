import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'vitest';
import type { CommandSchema } from '@agent-device/command-registry/command-schema';
import type { FlagKey } from '@agent-device/command-registry/flag-types';
import {
  buildCommandFacts,
  collectCommandFacts,
  driftReport,
  generatedCommands,
  generatedRegions,
  renderBlock,
  renderCommonOptionsBlock,
  renderPage,
  selectCommonFlagKeys,
  type CommandFacts,
} from '../../scripts/command-docs/generate.ts';

// Guards the generated regions in `website/docs/docs/commands.md`. A region restates
// what the command registry owns (summary, synopsis, options, aliases), so the
// committed region must equal what the registry renders today. Text outside the
// regions is hand-written and is not compared.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const PAGE_PATH = 'website/docs/docs/commands.md';
const GENERATOR = 'scripts/command-docs/generate.ts';
const committed = fs.readFileSync(path.join(REPO_ROOT, PAGE_PATH), 'utf8');

describe('generated command blocks match the command registry', () => {
  test('the committed blocks match the blocks the registry generates', () => {
    assert.equal(driftReport(committed, renderPage(committed)), null);
  });

  test('the generator command itself passes on the committed page', () => {
    execFileSync(process.execPath, ['--experimental-strip-types', GENERATOR], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  });

  test('the page marks blocks, each for a distinct command or the shared option table', () => {
    const commands = generatedCommands(committed);
    assert.notEqual(commands.length, 0, `${PAGE_PATH} marks no generated block`);
    assert.deepEqual(commands, [...new Set(commands)]);
    assert.ok(generatedRegions(committed).includes('common-options'));
    // An opening marker that the region pattern does not match would never be regenerated.
    assert.equal(committed.match(/<!-- generated:/g)?.length, generatedRegions(committed).length);
  });

  test('drift detection proves itself', () => {
    const [command] = generatedCommands(committed) as [string];
    const facts = collectCommandFacts(command);
    const changed = renderPage(committed, (name) =>
      name === command
        ? { ...facts, summary: `${facts.summary} changed` }
        : collectCommandFacts(name),
    );
    assert.match(driftReport(committed, changed) ?? '', /generate:command-docs/);
    assert.throws(
      () =>
        renderPage(committed.replace(`generated:command ${command} `, 'generated:command nope ')),
      /unknown command "nope"/,
    );
  });

  test('the shared option table drifts too', () => {
    const changed = renderPage(committed, undefined, () => ({
      options: [{ label: '--settle', description: 'changed' }],
    }));
    assert.match(driftReport(committed, changed) ?? '', /generate:command-docs/);
  });

  test('a block renders aliases and escapes option text for a table cell', () => {
    const block = renderBlock(commandFacts({ name: 'press' }));
    assert.match(block, /^Aliases: `tap`\.$/m);
    assert.ok(block.includes('| `--mode <a\\|b>` | Pick &lt;a> \\| &lt;b> |'));
    assert.doesNotMatch(block, /Supported targets/);
  });
});

/** A command's facts with the pilot's option row, so each test overrides only what it asserts. */
function commandFacts(overrides: Partial<CommandFacts> = {}): CommandFacts {
  return {
    name: 'press',
    summary: 'Press a target',
    usage: 'press <target>',
    aliases: ['tap'],
    flags: [{ label: '--mode <a|b>', description: 'Pick <a> | <b>' }],
    actions: [],
    commonOptions: [],
    capabilityRows: [],
    ...overrides,
  };
}

describe('a command with flagsByAction renders one option table per action', () => {
  const facts = commandFacts({
    name: 'record',
    summary: 'Record the screen',
    usage: 'record start [path] | record stop',
    aliases: [],
    flags: [],
    actions: [
      {
        label: 'record start',
        options: [
          { label: '--fps <n>', description: 'Record: sample frames' },
          { label: '--out <path>', description: 'Output path' },
        ],
      },
      { label: 'record stop', options: [] },
    ],
  });
  const block = renderBlock(facts);

  test('each action gets a bold label over its own table', () => {
    assert.match(block, /^\*\*`record start`\*\*$/m);
    assert.match(block, /^\| `--fps <n>` \| Record: sample frames \|$/m);
  });

  test('an action that reads no option says so instead of printing an empty table', () => {
    assert.match(block, /^\*\*`record stop`\*\*\n\nReads no options\.$/m);
    assert.equal(block.match(/\| Option \| What it does \|/g)?.length, 1);
  });

  test('the whole-command table is absent when every option belongs to an action', () => {
    assert.doesNotMatch(block, /^\| `--mode <a\|b>`/m);
  });
});

describe('shared options leave a command table for one line', () => {
  const schema = {
    text: { summary: 'Scroll', description: 'Scroll' },
    allowedFlags: ['until', 'settle', 'settleQuietMs', 'timeoutMs'] as FlagKey[],
  } as CommandSchema;

  test('a shared option drops out of the table and joins the Also accepts line', () => {
    const facts = buildCommandFacts('scroll', schema, new Set<FlagKey>(['settle', 'timeoutMs']));
    assert.deepEqual(
      facts.flags.map((flag) => flag.label),
      ['--until <selector>', '--settle-quiet <ms>'],
    );
    assert.deepEqual(facts.commonOptions, ['--settle', '--timeout <ms>']);
    assert.match(
      renderBlock(facts),
      /^Also accepts: \[common options\]\(#common-options\): `--settle`, `--timeout <ms>`\.$/m,
    );
  });

  test('an option a command overrides keeps its row with the override text', () => {
    const overridden = {
      ...schema,
      flagDescriptionOverrides: { timeoutMs: 'Replay: per-step budget' },
    } as CommandSchema;
    const facts = buildCommandFacts(
      'replay',
      overridden,
      new Set<FlagKey>(['settle', 'timeoutMs']),
    );
    assert.deepEqual(
      facts.flags.find((flag) => flag.label === '--timeout <ms>'),
      { key: 'timeoutMs', label: '--timeout <ms>', description: 'Replay: per-step budget' },
    );
    assert.deepEqual(facts.commonOptions, ['--settle']);
  });

  test('a shared option scoped to one action is documented on that action only', () => {
    const scoped = {
      text: { summary: 'Record', description: 'Record' },
      allowedFlags: ['out', 'fps', 'settle'] as FlagKey[],
      flagsByAction: { start: ['fps'], stop: [], 'contact-sheet': ['out'] },
    } as CommandSchema;
    const facts = buildCommandFacts('record', scoped, new Set<FlagKey>(['out', 'settle']));
    assert.deepEqual(
      facts.actions.map((action) => [action.label, action.options.map((option) => option.label)]),
      [
        ['record start', ['--fps <n>']],
        ['record stop', []],
        ['record contact-sheet', ['--out <path>']],
      ],
    );
    // `--out` belongs to one action, so it keeps its row there and stays out of the common line.
    assert.deepEqual(facts.commonOptions, ['--settle']);
  });

  test('the threshold and overrides decide the shared list', () => {
    const surfaces = [
      ...Array.from({ length: 5 }, (_, index) => ({
        command: `c${index}`,
        allowedFlags: ['settle'] as FlagKey[],
        overriddenFlags: [] as FlagKey[],
      })),
      { command: 'other', allowedFlags: ['until'] as FlagKey[], overriddenFlags: [] as FlagKey[] },
      {
        command: 'special',
        allowedFlags: ['until'] as FlagKey[],
        overriddenFlags: ['until'] as FlagKey[],
      },
    ];
    assert.deepEqual([...selectCommonFlagKeys(surfaces)], ['settle']);
  });
});

describe('the shared option table', () => {
  test('it names each shared option and points at per-command help', () => {
    const block = renderCommonOptionsBlock({
      options: [{ label: '--timeout <ms>', description: 'Budget for the command' }],
    });
    assert.ok(block.startsWith('<!-- generated:common-options -->'));
    assert.match(block, /^These options are allowed by 5 or more commands, so they are/m);
    assert.match(block, /^\| `--timeout <ms>` \| Budget for the command \|$/m);
    assert.match(block, /`agent-device help <command>`/);
  });
});

describe('several generated blocks share one section heading', () => {
  const page = [
    '## Input',
    '',
    'Hand-written prose.',
    '',
    '<!-- generated:command press -->',
    'stale',
    '<!-- /generated -->',
    '',
    'Between the blocks.',
    '',
    '<!-- generated:command longpress -->',
    'stale',
    '<!-- /generated -->',
    '',
  ].join('\n');

  test('each block is regenerated in place and the hand-written text survives', () => {
    const rendered = renderPage(page, (name) =>
      commandFacts({ name, summary: `Summary for ${name}`, aliases: [] }),
    );
    assert.deepEqual(generatedCommands(rendered), ['press', 'longpress']);
    assert.match(rendered, /^Summary for press\.$/m);
    assert.match(rendered, /^Summary for longpress\.$/m);
    assert.equal(rendered.match(/\| Option \| What it does \|/g)?.length, 2);
    assert.ok(rendered.includes('Hand-written prose.'));
    assert.ok(rendered.includes('Between the blocks.'));
    // Regenerating the rendered page changes nothing: two blocks under one heading are stable.
    assert.equal(
      renderPage(rendered, (name) =>
        commandFacts({ name, summary: `Summary for ${name}`, aliases: [] }),
      ),
      rendered,
    );
  });
});

describe('an option no action names gets one table of its own', () => {
  const schema = {
    text: { summary: 'Diff', description: 'Diff' },
    allowedFlags: ['baseline', 'threshold', 'screenshotScreenMask'] as FlagKey[],
    flagsByAction: { snapshot: [], screenshot: ['screenshotScreenMask'] },
  } as CommandSchema;
  const facts = buildCommandFacts('diff', schema, new Set<FlagKey>());

  test('an action table holds only what that action alone reads', () => {
    assert.deepEqual(
      facts.actions.map((action) => [action.label, action.options.map((option) => option.label)]),
      [
        ['diff snapshot', []],
        ['diff screenshot', ['--screen-mask <black>']],
        ['diff', ['--baseline, -b <path>', '--threshold <0-1>']],
      ],
    );
  });

  test('the every-action table is labelled as such and printed once', () => {
    const block = renderBlock(facts);
    assert.match(block, /^\*\*`diff snapshot`\*\*\n\nReads no options\.$/m);
    assert.match(block, /^\*\*Every `diff` action\*\*$/m);
    assert.equal(block.match(/^\| `--baseline, -b <path>` \|/gm)?.length, 1);
  });
});

test('a multi-line synopsis renders one command form per line and no help prose', () => {
  const block = renderBlock(
    commandFacts({
      name: 'perf',
      usage:
        'perf frames --json\n  agent-device perf memory sample --json\n\n  Aggregate perf was removed.',
    }),
  );
  assert.match(
    block,
    /```bash\nagent-device perf frames --json\nagent-device perf memory sample --json\n```/,
  );
  assert.doesNotMatch(block, /Aggregate perf was removed/);
});
