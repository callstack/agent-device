import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'vitest';
import {
  collectCommandFacts,
  driftReport,
  generatedCommands,
  renderBlock,
  renderPage,
} from '../../scripts/command-docs/generate.ts';

// Guards the generated blocks in `website/docs/docs/commands.md`. A block restates
// what the command registry owns (summary, synopsis, options, aliases), so the
// committed block must equal what the registry renders today. Text outside the
// blocks is hand-written and is not compared.

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

  test('the page marks blocks, each for a distinct command', () => {
    const commands = generatedCommands(committed);
    assert.notEqual(commands.length, 0, `${PAGE_PATH} marks no generated block`);
    assert.deepEqual(commands, [...new Set(commands)]);
    // An opening marker that the block pattern does not match would never be regenerated.
    assert.equal(committed.match(/<!-- generated:/g)?.length, commands.length);
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

  test('a block renders aliases and escapes option text for a table cell', () => {
    const block = renderBlock({
      name: 'press',
      summary: 'Press a target',
      usage: 'press <target>',
      aliases: ['tap'],
      flags: [{ label: '--mode <a|b>', description: 'Pick <a> | <b>' }],
      capabilityRows: [],
    });
    assert.match(block, /^Aliases: `tap`\.$/m);
    assert.ok(block.includes('| `--mode <a\\|b>` | Pick &lt;a> \\| &lt;b> |'));
    assert.doesNotMatch(block, /Supported targets/);
  });
});
