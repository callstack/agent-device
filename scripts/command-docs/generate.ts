// `node scripts/command-docs/generate.ts [--write]` — renders the generated blocks in
// `website/docs/docs/commands.md`.
//
// A block is the text between `<!-- generated:command <name> -->` and `<!-- /generated -->`.
// It carries the facts the command registry already owns: the summary, the synopsis, the
// CLI aliases, the options with their help text, and where the capabilities page answers
// for the command. Everything outside a block is hand-written and is never touched.
// Without `--write` the script compares the page on disk against the generated page and
// fails when they differ, which is what the drift guard runs.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import { cliAliasesForCommand } from '@agent-device/command-registry/cli-command-aliases';
import type { CommandSchema } from '@agent-device/command-registry/command-schema';
import { getCliCommandSchema } from '@agent-device/command-surface';
import { buildCommandUsage, commandHelpFlags } from '../../src/commands/schema/usage.ts';
import { MATRIX_SECTIONS } from '../capability-matrix/annotations.ts';
import { firstDifference } from '../capability-matrix/generate.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const PAGE_PATH = path.join('website', 'docs', 'docs', 'commands.md');

const BLOCK = /<!-- generated:command (\S+) -->\n[\s\S]*?<!-- \/generated -->/g;

export type CommandFacts = Readonly<{
  name: string;
  summary: string;
  usage: string;
  aliases: readonly string[];
  flags: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  capabilityRows: ReadonlyArray<{ readonly label: string; readonly link: string }>;
}>;

function helpFlags(schema: CommandSchema): CommandFacts['flags'] {
  return commandHelpFlags(schema).map((definition) => ({
    label: definition.usageLabel ?? '',
    description: definition.usageDescription ?? '',
  }));
}

/** Starlight's heading slug for the plain-word section titles the capabilities page prints. */
function headingSlug(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9 -]/g, '')
    .replaceAll(' ', '-');
}

function capabilityRows(command: string): CommandFacts['capabilityRows'] {
  return MATRIX_SECTIONS.flatMap((section) =>
    section.rows
      .filter((row) => row.commands.includes(command))
      .map((row) => ({
        label: row.label,
        link: `/docs/capabilities#${headingSlug(section.title)}`,
      })),
  );
}

export function collectCommandFacts(name: string): CommandFacts {
  const command = listCliCommandNames().find((candidate) => candidate === name);
  if (command === undefined) {
    throw new Error(`${PAGE_PATH} marks a generated block for unknown command "${name}".`);
  }
  const schema = getCliCommandSchema(command);
  return {
    name,
    summary: schema.text.summary,
    usage: buildCommandUsage(name, schema),
    aliases: cliAliasesForCommand(name).map((entry) => entry.alias),
    flags: helpFlags(schema),
    capabilityRows: capabilityRows(name),
  };
}

/** Table-cell text: the help strings hold `|` and `<placeholder>` tokens that Markdown would eat. */
function cell(text: string): string {
  return text.replaceAll('|', String.raw`\|`).replaceAll('<', '&lt;');
}

export function renderBlock(facts: CommandFacts): string {
  const lines = [
    `<!-- generated:command ${facts.name} -->`,
    '',
    `${facts.summary}.`,
    '',
    '```bash',
    `agent-device ${facts.usage}`,
    '```',
    '',
  ];
  if (facts.aliases.length > 0) {
    lines.push(`Aliases: ${facts.aliases.map((alias) => `\`${alias}\``).join(', ')}.`, '');
  }
  if (facts.flags.length > 0) {
    lines.push('| Option | What it does |', '| --- | --- |');
    for (const flag of facts.flags) {
      lines.push(
        `| \`${flag.label.replaceAll('|', String.raw`\|`)}\` | ${cell(flag.description)} |`,
      );
    }
    lines.push('');
  }
  if (facts.capabilityRows.length > 0) {
    const links = facts.capabilityRows.map((row) => `[${row.label}](${row.link})`).join(', ');
    lines.push(`Supported targets: ${links}.`, '');
  }
  lines.push(`Exact behavior: \`agent-device help ${facts.name}\`.`, '', '<!-- /generated -->');
  return lines.join('\n');
}

/** The page with every marked block rendered again; text outside the blocks is returned as is. */
export function renderPage(
  committed: string,
  collect: (name: string) => CommandFacts = collectCommandFacts,
): string {
  return committed.replaceAll(BLOCK, (_block, name: string) => renderBlock(collect(name)));
}

export function generatedCommands(page: string): string[] {
  return [...page.matchAll(BLOCK)].map((match) => match[1] as string);
}

export function driftReport(committed: string, generated: string): string | null {
  if (committed === generated) return null;
  return (
    `${PAGE_PATH} is stale. Run \`pnpm generate:command-docs\`.\nFirst difference:\n` +
    firstDifference(committed, generated)
  );
}

function main(argv: readonly string[]): number {
  const target = path.join(REPO_ROOT, PAGE_PATH);
  const committed = fs.readFileSync(target, 'utf8');
  const page = renderPage(committed);
  const drift = driftReport(committed, page);
  if (drift === null) {
    process.stdout.write(`${PAGE_PATH} is current.\n`);
    return 0;
  }
  if (!argv.includes('--write')) {
    process.stderr.write(`${drift}\n`);
    return 1;
  }
  fs.writeFileSync(target, page);
  process.stdout.write(`Wrote ${PAGE_PATH}.\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
