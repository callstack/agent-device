import assert from 'node:assert/strict';
import { test } from 'vitest';
import { listCliCommandNames } from '../command-catalog.ts';
import { usage, usageForCommand } from '../cli/parser/args.ts';

test('root help is a bounded first-success decision card', async () => {
  const help = await usage();

  assert.ok(
    Buffer.byteLength(help, 'utf8') <= 3000,
    `root help must stay within the 3000-byte decision-card budget, was ${Buffer.byteLength(help, 'utf8')} bytes`,
  );
  assert.match(help, /All \d+ commands: agent-device help commands/);
  assert.match(help, /starting a task with a known app/);
  assert.match(help, /agent-device open <app> --foreground/);
  assert.match(help, /scroll <direction\|top\|bottom> \[amount\] --settle; back --settle/);
  assert.match(help, /Do not probe first with devices, apps, appstate, snapshot, or screenshot/);
  assert.match(help, /Copy refs exactly: @e12, @e12~s4/);
  assert.match(help, /Coordinates are last resort/);
  assert.doesNotMatch(help, /^Commands:/m);
  assert.doesNotMatch(help, /^Global Flags:/m);
});

test('root help overview names only commands from the derived catalog', async () => {
  const help = await usage();
  const commandsSection = help.match(
    /More commands \(exact shapes: agent-device help <command>\):\n(?<lines>[\s\S]+?)\n\nGuides/,
  )?.groups?.lines;
  assert.ok(commandsSection, 'expected a More commands section');

  const catalog = new Set<string>(listCliCommandNames());
  const overviewCommands = commandsSection.split('\n').flatMap((line) =>
    line
      .trim()
      .split(/\s{2,}/, 1)[0]!
      .split(/\s+/),
  );
  for (const command of overviewCommands) {
    assert.ok(catalog.has(command), `root help names unknown command: ${command}`);
  }
});

test('help commands preserves the complete reference displaced from root help', async () => {
  const help = await usageForCommand('commands');
  if (help === null) throw new Error('Expected commands help text');

  assert.match(help, /^agent-device \S+ — commands/);
  assert.match(help, /^Commands:/m);
  assert.match(help, /install-from-source\s{2,}Install app builds from URLs or CI artifacts/);
  assert.match(help, /^Global Flags:/m);
  assert.match(help, /^Configuration:/m);
  assert.match(help, /^Environment:/m);
  assert.match(help, /^Examples:/m);
});
