// `node scripts/command-docs/generate.ts [--write]` — renders the generated blocks in
// `website/docs/docs/commands.md`.
//
// A block is the text between its `<!-- generated:… -->` marker and `<!-- /generated -->`.
// Two ids exist: `generated:command <name>` carries the facts one command's registry entry owns
// (the summary, the synopsis, the CLI aliases, the options with their help text, and where the
// capabilities page answers for the command), and `generated:common-options` carries the options
// many commands allow, documented once instead of once per command. Everything outside a block is
// hand-written and is never touched.
// Without `--write` the script compares the page on disk against the generated page and
// fails when they differ, which is what the drift guard runs.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PUBLIC_COMMANDS, listCliCommandNames } from '@agent-device/command-registry/catalog';
import { cliAliasesForCommand } from '@agent-device/command-registry/cli-command-aliases';
import type { CommandSchema } from '@agent-device/command-registry/command-schema';
import type { FlagKey } from '@agent-device/command-registry/flag-types';
import { getCliCommandSchema } from '@agent-device/command-surface';
import {
  buildCommandUsage,
  commandHelpFlags,
  listHelpFlags,
} from '../../src/commands/schema/usage.ts';
import { MATRIX_SECTIONS } from '../capability-matrix/annotations.ts';
import { firstDifference } from '../capability-matrix/generate.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const PAGE_PATH = path.join('website', 'docs', 'docs', 'commands.md');

/** The heading slug and anchor `## Common options` renders to, and the page shares by name. */
const COMMON_OPTIONS_ID = 'common-options';

/**
 * How many public CLI commands must allow an option before the page documents it once under
 * `## Common options` instead of repeating a row per command. Below it, the command's own table is
 * the shorter read; above it, the shared row wins and each command names the option in one line.
 */
const COMMON_OPTION_MIN_COMMANDS = 5;

// One region per `<!-- generated:… -->` marker: either one command or the shared option table.
const REGION = new RegExp(
  String.raw`<!-- generated:(command (\S+)|${COMMON_OPTIONS_ID}) -->\n[\s\S]*?<!-- \/generated -->`,
  'g',
);
const COMMAND_ID_PREFIX = 'command ';

export type OptionRow = Readonly<{ readonly label: string; readonly description: string }>;

export type CommandFacts = Readonly<{
  name: string;
  summary: string;
  usage: string;
  aliases: readonly string[];
  /** Options the whole command reads, minus the ones the shared table owns. Empty per action. */
  flags: readonly OptionRow[];
  /** One table per action a command's first positional selects, when it has `flagsByAction`. */
  actions: ReadonlyArray<
    Readonly<{ label: string; options: readonly OptionRow[]; everyAction?: boolean }>
  >;
  /** Labels of the shared options this command reads on every action. */
  commonOptions: readonly string[];
  capabilityRows: ReadonlyArray<{ readonly label: string; readonly link: string }>;
}>;

export type CommonOptionFacts = Readonly<{ options: readonly OptionRow[] }>;

/**
 * One public command's option surface: what it parses, and which of those keys replace their own
 * help text for that command. A key with an override is never a shared row: its sentence belongs to
 * the one command that wrote it.
 */
export type CommandFlagSurface = Readonly<{
  command: string;
  allowedFlags: readonly FlagKey[];
  overriddenFlags: readonly FlagKey[];
}>;

/** The option surface of every public CLI command, read from the registry. */
function publicCommandFlagSurfaces(): CommandFlagSurface[] {
  return Object.values(PUBLIC_COMMANDS).map((command) => {
    const schema = getCliCommandSchema(command);
    return {
      command,
      allowedFlags: schema.allowedFlags ?? [],
      overriddenFlags: Object.keys(schema.flagDescriptionOverrides ?? {}) as FlagKey[],
    };
  });
}

/**
 * The keys the page documents once for all commands: allowed by at least
 * `COMMON_OPTION_MIN_COMMANDS` public commands, with help text to show, and with no command
 * overriding that text. Ordered as the flag registry declares them.
 */
export function selectCommonFlagKeys(surfaces: readonly CommandFlagSurface[]): readonly FlagKey[] {
  const counts = new Map<FlagKey, number>();
  const overridden = new Set<FlagKey>();
  for (const surface of surfaces) {
    for (const key of new Set(surface.allowedFlags)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const key of surface.overriddenFlags) overridden.add(key);
  }
  const candidates = [...counts.entries()]
    .filter(([key, count]) => count >= COMMON_OPTION_MIN_COMMANDS && !overridden.has(key))
    .map(([key]) => key);
  // `listHelpFlags` is the page's row source, so a key it drops (no CLI label or no help text)
  // is not a shared row either: no command would print its label in its `Also accepts` line.
  return listHelpFlags(new Set(candidates)).map((definition) => definition.key);
}

type OptionRowWithKey = OptionRow & { readonly key: FlagKey };

/** Option rows for these keys, in flag-registry order — the order `--help` lists them in. */
function optionRows(keys: Iterable<FlagKey>): OptionRowWithKey[] {
  return listHelpFlags(new Set(keys)).map((definition) => ({
    key: definition.key,
    label: definition.usageLabel ?? '',
    description: definition.usageDescription ?? '',
  }));
}

/** The options `agent-device help <command>` lists, with the command's own override text. */
function helpFlags(schema: CommandSchema): OptionRowWithKey[] {
  return commandHelpFlags(schema).map((definition) => ({
    key: definition.key,
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

/**
 * The facts for one command, from its schema and the shared option keys.
 *
 * A shared option the command reads on every action leaves its table, and the command names it in
 * one `Also accepts` line. An option the command overrides keeps its row, with the override text,
 * and is left out of that line. A command that declares `flagsByAction` gets one table per action:
 * an option only some actions read would otherwise read as available to all of them. An option no
 * action names is read by all of them: it gets one table of its own, never a copy under each action,
 * so an action's table holds only what that action alone reads. A shared one of those leaves for
 * the `Also accepts` line; an option the shared table owns for one action only keeps its row there,
 * because which action reads it is the fact the placement carries.
 */
export function buildCommandFacts(
  command: string,
  schema: CommandSchema,
  commonKeys: ReadonlySet<FlagKey>,
): CommandFacts {
  const allowedFlags = schema.allowedFlags ?? [];
  const overrides = schema.flagDescriptionOverrides;
  // A key the shared table owns for this command, unless the command states its own text for it.
  const shared = (key: FlagKey): boolean => commonKeys.has(key) && overrides?.[key] === undefined;
  const keeps = (key: FlagKey): boolean => !commonKeys.has(key) || overrides?.[key] !== undefined;
  const sharedLabels = (keys: Iterable<FlagKey>): string[] =>
    optionRows(keys).map((row) => row.label);
  const base = {
    name: command,
    summary: schema.text.summary,
    usage: buildCommandUsage(command, schema),
    aliases: cliAliasesForCommand(command).map((entry) => entry.alias),
    capabilityRows: [] as const,
  };

  const flagsByAction = schema.flagsByAction;
  if (flagsByAction === undefined) {
    return {
      ...base,
      flags: helpFlags(schema).filter((row) => keeps(row.key)),
      actions: [],
      commonOptions: sharedLabels(allowedFlags.filter(shared)),
    };
  }

  // A key no action names is read by all of them, so it gets the every-action table; a shared one of
  // those leaves for the command's `Also accepts` line instead.
  const actionScoped = new Set(Object.values(flagsByAction).flat());
  const readByEveryAction = allowedFlags.filter((key) => !actionScoped.has(key) && !shared(key));
  const tableFor = (keys: Iterable<FlagKey>): OptionRow[] =>
    helpFlags({ ...schema, allowedFlags: [...keys] } as CommandSchema).map((row) => ({
      label: row.label,
      description: row.description,
    }));
  return {
    ...base,
    flags: [],
    actions: [
      ...Object.entries(flagsByAction).map(([action, keys]) => ({
        label: `${command} ${action}`,
        options: tableFor(keys),
      })),
      ...(readByEveryAction.length > 0
        ? [{ label: command, options: tableFor(readByEveryAction), everyAction: true }]
        : []),
    ],
    commonOptions: sharedLabels(
      allowedFlags.filter((key) => shared(key) && !actionScoped.has(key)),
    ),
  };
}

export function collectCommandFacts(name: string): CommandFacts {
  const command = listCliCommandNames().find((candidate) => candidate === name);
  if (command === undefined) {
    throw new Error(`${PAGE_PATH} marks a generated block for unknown command "${name}".`);
  }
  return {
    ...buildCommandFacts(
      command,
      getCliCommandSchema(command),
      new Set(selectCommonFlagKeys(publicCommandFlagSurfaces())),
    ),
    capabilityRows: capabilityRows(name),
  };
}

/** The shared option table's facts. */
function collectCommonOptionFacts(): CommonOptionFacts {
  return { options: optionRows(selectCommonFlagKeys(publicCommandFlagSurfaces())) };
}

/** Table-cell text: the help strings hold `|` and `<placeholder>` tokens that Markdown would eat. */
function cell(text: string): string {
  return text.replaceAll('|', String.raw`\|`).replaceAll('<', '&lt;');
}

function optionTable(options: readonly OptionRow[]): string[] {
  const lines = ['| Option | What it does |', '| --- | --- |'];
  for (const flag of options) {
    lines.push(`| \`${flag.label.replaceAll('|', String.raw`\|`)}\` | ${cell(flag.description)} |`);
  }
  lines.push('');
  return lines;
}

/** The one line a command prints in place of the rows the shared table owns. */
function commonOptionsLine(labels: readonly string[]): string[] {
  return [
    `Also accepts: [common options](#${COMMON_OPTIONS_ID}): ${labels
      .map((label) => `\`${label}\``)
      .join(', ')}.`,
    '',
  ];
}

/**
 * The command forms of a synopsis, one per line. A multi-line synopsis is written for the terminal:
 * its later lines carry their own `agent-device` prefix and indentation, and a paragraph after a
 * blank line is help prose. The fence takes the forms only.
 */
function usageLines(usage: string): string[] {
  const forms = usage.split('\n\n')[0]!.split('\n');
  return forms.map((form) => {
    const line = form.trim();
    return line.startsWith('agent-device ') ? line : `agent-device ${line}`;
  });
}

export function renderBlock(facts: CommandFacts): string {
  const lines = [
    `<!-- generated:command ${facts.name} -->`,
    '',
    `${facts.summary}.`,
    '',
    '```bash',
    ...usageLines(facts.usage),
    '```',
    '',
  ];
  if (facts.aliases.length > 0) {
    lines.push(`Aliases: ${facts.aliases.map((alias) => `\`${alias}\``).join(', ')}.`, '');
  }
  if (facts.actions.length > 0) {
    // With an every-action table below, an empty action still reads those options.
    const noOptions = facts.actions.some((action) => action.everyAction)
      ? 'No options of its own.'
      : 'Reads no options.';
    for (const action of facts.actions) {
      lines.push(
        action.everyAction ? `**Every \`${action.label}\` action**` : `**\`${action.label}\`**`,
        '',
      );
      lines.push(...(action.options.length > 0 ? optionTable(action.options) : [noOptions, '']));
    }
  } else if (facts.flags.length > 0) {
    lines.push(...optionTable(facts.flags));
  }
  if (facts.commonOptions.length > 0) {
    lines.push(...commonOptionsLine(facts.commonOptions));
  }
  if (facts.capabilityRows.length > 0) {
    const links = facts.capabilityRows.map((row) => `[${row.label}](${row.link})`).join(', ');
    lines.push(`Supported targets: ${links}.`, '');
  }
  lines.push(`Exact behavior: \`agent-device help ${facts.name}\`.`, '', '<!-- /generated -->');
  return lines.join('\n');
}

export function renderCommonOptionsBlock(facts: CommonOptionFacts): string {
  const labels = facts.options.map((option) => `\`${option.label}\``).join(', ');
  return [
    `<!-- generated:${COMMON_OPTIONS_ID} -->`,
    '',
    `These options are allowed by ${COMMON_OPTION_MIN_COMMANDS} or more commands, so they are` +
      ` documented here once: ${labels}. A command's own entry omits them and names them in its` +
      ` \`Also accepts\` line. The shared row is the general case: where a command's semantics` +
      ` differ, that command states its own row.`,
    '',
    ...optionTable(facts.options),
    `Exact behavior for one command: \`agent-device help <command>\`.`,
    '',
    '<!-- /generated -->',
  ].join('\n');
}

/** The page with every marked block rendered again; text outside the blocks is returned as is. */
export function renderPage(
  committed: string,
  collect: (name: string) => CommandFacts = collectCommandFacts,
  collectCommon: () => CommonOptionFacts = collectCommonOptionFacts,
): string {
  return committed.replaceAll(REGION, (_region, id: string, command: string | undefined) =>
    id === COMMON_OPTIONS_ID
      ? renderCommonOptionsBlock(collectCommon())
      : renderBlock(collect(command as string)),
  );
}

/** The id of every marked region: `command <name>`, or `common-options`. */
export function generatedRegions(page: string): string[] {
  return [...page.matchAll(REGION)].map((match) => match[1] as string);
}

export function generatedCommands(page: string): string[] {
  return generatedRegions(page)
    .filter((id) => id.startsWith(COMMAND_ID_PREFIX))
    .map((id) => id.slice(COMMAND_ID_PREFIX.length));
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
