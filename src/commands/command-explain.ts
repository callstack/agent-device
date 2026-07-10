import { listCliCommandNames } from '../command-catalog.ts';
import { cliAliasesForCommand, normalizeCliCommandAlias } from '../cli-command-aliases.ts';
import { buildCommandUsage } from '../utils/cli-usage.ts';
import type { DaemonCommandRoute } from '../daemon/daemon-command-registry.ts';
import { commandDescriptors, type Command } from '../core/command-descriptor/registry.ts';
import { ownerFilesForCommand } from '../core/command-descriptor/owner-files.ts';
import type { CommandCapability } from '../core/capabilities.ts';
import type { CommandTimeoutPolicy } from '../core/command-descriptor/types.ts';
import {
  getCliCommandSchema,
  getFlagDefinitions,
  GLOBAL_FLAG_KEYS,
  type CommandSchema,
  type FlagDefinition,
  type FlagKey,
} from '../utils/command-schema.ts';
import { commandFamilies, type CommandFamilyMetadata } from './family/registry.ts';

export type CommandFlagExplanation = {
  key: FlagKey;
  syntax: string;
  description?: string;
};

export type CommandAliasExplanation = {
  /** User-typed CLI token the parser rewrites to this command. */
  alias: string;
  /** Flags the alias implicitly sets (e.g. `relaunch` => `open --relaunch`). */
  impliedFlags?: FlagKey[];
};

export type CommandExplanation = {
  command: Command;
  aliases: CommandAliasExplanation[];
  description: string;
  catalog: { group: string; key: string };
  family?: string;
  daemon?: { route: string; traits: string[] };
  capability?: CommandCapability;
  exposure: {
    batchable: boolean;
    mcp: boolean;
    dispatch: boolean;
    postActionObservation?: string;
  };
  timeout: {
    envelopeMs: number | 'unbounded';
    onTimeout: 'preserve-daemon' | 'reset-daemon';
    budget: string;
  };
  cli?: {
    usage: string;
    positionalArgs: readonly string[];
    commandFlags: CommandFlagExplanation[];
    supportedFlags: CommandFlagExplanation[];
    globalFlags: CommandFlagExplanation[];
  };
  files: string[];
};

export type CommandExplanationResult =
  | { found: true; explanation: CommandExplanation }
  | { found: false; query: string; suggestions: string[] };

export type CommandExplanationFormatOptions = {
  detail?: 'compact' | 'full';
};

type FileExists = (repoRelativePath: string) => boolean;
type CommandDescriptor = (typeof commandDescriptors)[number];
type CommandExplanationOptions = {
  fileExists?: FileExists;
  daemonRouteOwnerFiles: Readonly<Record<DaemonCommandRoute, string>>;
};

const descriptorByName: ReadonlyMap<string, CommandDescriptor> = new Map(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor]),
);
const cliCommandNames = new Set<string>(listCliCommandNames());
const flagDefinitionsByKey = groupFlagDefinitions();

export function explainCommand(
  query: string,
  options: CommandExplanationOptions,
): CommandExplanationResult {
  const descriptor = resolveDescriptor(query);
  if (!descriptor) {
    return { found: false, query, suggestions: suggestCommands(query) };
  }
  return {
    found: true,
    explanation: buildCommandExplanation(
      descriptor,
      options.fileExists,
      options.daemonRouteOwnerFiles,
    ),
  };
}

function buildCommandExplanation(
  descriptor: CommandDescriptor,
  fileExists: FileExists | undefined,
  daemonRouteOwnerFiles: Readonly<Record<DaemonCommandRoute, string>>,
): CommandExplanation {
  const family = commandFamilies.find((candidate) =>
    candidate.metadata.some((metadata) => metadata.name === descriptor.name),
  );
  const cliSchema = cliCommandNames.has(descriptor.name)
    ? getCliCommandSchema(descriptor.name as Parameters<typeof getCliCommandSchema>[0])
    : undefined;
  const catalogKey = readCatalogKey(descriptor);
  return {
    command: descriptor.name,
    aliases: describeCliAliases(descriptor.name),
    description: describeCommandText(descriptor, family, cliSchema),
    catalog: { group: descriptor.catalog.group, key: catalogKey },
    ...(family ? { family: family.name } : {}),
    ...describeCommandDaemon(descriptor),
    ...describeCommandCapability(descriptor),
    exposure: describeCommandExposure(descriptor),
    timeout: describeTimeoutPolicy(descriptor.timeoutPolicy),
    ...(cliSchema ? { cli: describeCliSurface(descriptor.name, cliSchema) } : {}),
    files: commandFiles(
      descriptor.name,
      ownerFilesForCommand(descriptor.name),
      family?.name,
      'daemon' in descriptor ? descriptor.daemon?.route : undefined,
      Boolean('capability' in descriptor && descriptor.capability),
      Boolean('dispatch' in descriptor && descriptor.dispatch),
      fileExists,
      daemonRouteOwnerFiles,
    ),
  };
}

export function formatCommandExplanation(
  explanation: CommandExplanation,
  options: CommandExplanationFormatOptions = {},
): string {
  const full = options.detail === 'full';
  const lines = [
    `${explanation.command} [${explanation.catalog.group}]`,
    explanation.description,
    `catalog: ${explanation.catalog.key}${formatAliasSuffix(explanation.aliases)}`,
    `family: ${explanation.family ?? 'none'}`,
    explanation.daemon
      ? `daemon: ${explanation.daemon.route}${explanation.daemon.traits.length ? ` (${explanation.daemon.traits.join(', ')})` : ''}`
      : 'daemon: none',
    `exposure: batch=${yesNo(explanation.exposure.batchable)}, mcp=${yesNo(explanation.exposure.mcp)}, dispatch=${yesNo(explanation.exposure.dispatch)}${explanation.exposure.postActionObservation ? `, observe=${explanation.exposure.postActionObservation}` : ''}`,
    `timeout: envelope=${formatEnvelope(explanation.timeout.envelopeMs)}, on-timeout=${explanation.timeout.onTimeout}, budget=${explanation.timeout.budget}`,
  ];
  if (explanation.capability) {
    lines.push(`capability: ${JSON.stringify(explanation.capability)}`);
  }
  if (explanation.cli) {
    lines.push(`usage: ${explanation.cli.usage}`);
    lines.push(`flags: ${formatFlagList(explanation.cli.commandFlags)}`);
    if (full) {
      lines.push(`supported: ${formatFlagList(explanation.cli.supportedFlags)}`);
      lines.push(`global: ${formatFlagList(explanation.cli.globalFlags)}`);
    }
  }
  lines.push('files:', ...explanation.files.map((file) => `  ${file}`));
  return lines.join('\n');
}

function resolveDescriptor(query: string): CommandDescriptor | undefined {
  const direct = descriptorByName.get(normalizeCliCommandAlias(query));
  if (direct) return direct;
  return commandDescriptors.find((descriptor) => readCatalogKey(descriptor) === query);
}

function describeCliAliases(command: string): CommandAliasExplanation[] {
  return cliAliasesForCommand(command).map((entry) => ({
    alias: entry.alias,
    ...(entry.impliedFlags && entry.impliedFlags.length > 0
      ? { impliedFlags: [...entry.impliedFlags] }
      : {}),
  }));
}

function formatAliasSuffix(aliases: readonly CommandAliasExplanation[]): string {
  if (aliases.length === 0) return '';
  const rendered = aliases.map((entry) =>
    entry.impliedFlags && entry.impliedFlags.length > 0
      ? `${entry.alias} (implies ${entry.impliedFlags.map((flag) => `--${flag}`).join(' ')})`
      : entry.alias,
  );
  return ` (alias: ${rendered.join(', ')})`;
}

function readCatalogKey(descriptor: CommandDescriptor): string {
  return 'key' in descriptor.catalog && descriptor.catalog.key
    ? descriptor.catalog.key
    : descriptor.name;
}

function describeCommandText(
  descriptor: CommandDescriptor,
  family: (typeof commandFamilies)[number] | undefined,
  cliSchema: CommandSchema | undefined,
): string {
  const metadata = family?.metadata.find(
    (candidate): candidate is CommandFamilyMetadata => candidate.name === descriptor.name,
  );
  return (
    metadata?.description ?? cliSchema?.helpDescription ?? `Internal command ${descriptor.name}`
  );
}

function describeCommandDaemon(descriptor: CommandDescriptor): Pick<CommandExplanation, 'daemon'> {
  if (!('daemon' in descriptor) || !descriptor.daemon) return {};
  return {
    daemon: {
      route: descriptor.daemon.route,
      traits: describeDaemonTraits(descriptor.daemon),
    },
  };
}

function describeCommandCapability(
  descriptor: CommandDescriptor,
): Pick<CommandExplanation, 'capability'> {
  if (!('capability' in descriptor) || !descriptor.capability) return {};
  return { capability: descriptor.capability };
}

function describeCommandExposure(descriptor: CommandDescriptor): CommandExplanation['exposure'] {
  return {
    batchable: descriptor.batchable,
    mcp: descriptor.mcpExposed,
    dispatch: 'dispatch' in descriptor && descriptor.dispatch !== undefined,
    ...('postActionObservation' in descriptor && descriptor.postActionObservation
      ? { postActionObservation: descriptor.postActionObservation }
      : {}),
  };
}

function suggestCommands(query: string): string[] {
  const candidates = commandDescriptors.flatMap((descriptor) => [
    descriptor.name,
    readCatalogKey(descriptor),
    ...cliAliasesForCommand(descriptor.name).map((alias) => alias.alias),
  ]);
  return [...new Set(candidates)]
    .map((candidate) => ({ candidate, distance: levenshtein(query, candidate) }))
    .sort(
      (left, right) =>
        left.distance - right.distance || left.candidate.localeCompare(right.candidate),
    )
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

function describeDaemonTraits(daemon: { route: string } & Record<string, unknown>): string[] {
  return Object.entries(daemon)
    .filter(([key]) => key !== 'route')
    .map(([key, value]) => `${key}=${describeTraitValue(value)}`)
    .sort();
}

function describeTraitValue(value: unknown): string {
  if (typeof value === 'function') return 'derived-policy';
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return String(value);
  return JSON.stringify(value);
}

function describeTimeoutPolicy(policy: CommandTimeoutPolicy): CommandExplanation['timeout'] {
  const budget =
    policy.budget.source === 'none'
      ? 'none'
      : policy.budget.source === 'positional-parser'
        ? 'positional'
        : `flag:${policy.budget.envelope ?? 'bound'}${policy.budget.defaultBudgetMs === undefined ? '' : `:default=${policy.budget.defaultBudgetMs}ms`}`;
  return { envelopeMs: policy.envelopeMs, onTimeout: policy.onTimeout, budget };
}

function describeCliSurface(command: string, schema: CommandSchema): CommandExplanation['cli'] {
  return {
    usage: buildCommandUsage(command, schema),
    positionalArgs: schema.positionalArgs ?? [],
    commandFlags: describeFlags(schema.allowedFlags ?? []),
    supportedFlags: describeFlags(schema.supportedFlags ?? []),
    globalFlags: describeFlags([...GLOBAL_FLAG_KEYS]),
  };
}

function describeFlags(keys: readonly FlagKey[]): CommandFlagExplanation[] {
  return [...new Set(keys)].sort().map((key) => {
    const definitions = flagDefinitionsByKey.get(key) ?? [];
    const preferred = definitions.find((definition) => definition.usageLabel) ?? definitions[0];
    return {
      key,
      syntax:
        preferred?.usageLabel ??
        [...new Set(definitions.flatMap((definition) => definition.names))].join('/'),
      ...(preferred?.usageDescription ? { description: preferred.usageDescription } : {}),
    };
  });
}

function groupFlagDefinitions(): Map<FlagKey, FlagDefinition[]> {
  const result = new Map<FlagKey, FlagDefinition[]>();
  for (const definition of getFlagDefinitions()) {
    const existing = result.get(definition.key);
    if (existing) existing.push(definition);
    else result.set(definition.key, [definition]);
  }
  return result;
}

function commandFiles(
  command: string,
  ownerFiles: readonly string[],
  family: string | undefined,
  daemonRoute: DaemonCommandRoute | undefined,
  hasCapability: boolean,
  hasDispatch: boolean,
  fileExists: FileExists | undefined,
  daemonRouteOwnerFiles: Readonly<Record<DaemonCommandRoute, string>>,
): string[] {
  const derived = ['src/core/command-descriptor/registry.ts'];
  const opportunistic: string[] = [];
  if (family) {
    derived.push(`src/commands/${family}/index.ts`);
    opportunistic.push(
      `src/commands/${family}/${command}.test.ts`,
      `src/commands/${family}/index.test.ts`,
    );
  } else if (cliCommandNames.has(command)) {
    derived.push('src/utils/cli-command-overrides.ts');
  }
  if (daemonRoute) derived.push(daemonRouteOwnerFiles[daemonRoute]);
  if (hasDispatch) derived.push('src/core/dispatch.ts');
  if (hasCapability) derived.push('src/core/capabilities.ts');
  const present = fileExists ? opportunistic.filter(fileExists) : opportunistic;
  return [...new Set([...derived, ...ownerFiles, ...present])];
}

function formatFlagList(flags: readonly CommandFlagExplanation[]): string {
  return flags.length === 0 ? 'none' : flags.map((flag) => flag.syntax || flag.key).join(', ');
}

function formatEnvelope(envelope: number | 'unbounded'): string {
  return envelope === 'unbounded' ? envelope : `${envelope}ms`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}
