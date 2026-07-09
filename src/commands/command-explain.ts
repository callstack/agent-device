import { listCliCommandNames } from '../command-catalog.ts';
import { commandDescriptors, type Command } from '../core/command-descriptor/registry.ts';
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

export type CommandExplanation = {
  command: Command;
  aliases: string[];
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

type FileExists = (repoRelativePath: string) => boolean;

const descriptorByName: ReadonlyMap<string, (typeof commandDescriptors)[number]> = new Map(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor]),
);
const cliCommandNames = new Set<string>(listCliCommandNames());
const flagDefinitionsByKey = groupFlagDefinitions();

export function explainCommand(
  query: string,
  options: { fileExists?: FileExists } = {},
): CommandExplanationResult {
  const descriptor = resolveDescriptor(query);
  if (!descriptor) {
    return { found: false, query, suggestions: suggestCommands(query) };
  }

  const family = commandFamilies.find((candidate) =>
    candidate.metadata.some((metadata) => metadata.name === descriptor.name),
  );
  const metadata = family?.metadata.find(
    (candidate): candidate is CommandFamilyMetadata => candidate.name === descriptor.name,
  );
  const cliSchema = cliCommandNames.has(descriptor.name)
    ? getCliCommandSchema(descriptor.name as Parameters<typeof getCliCommandSchema>[0])
    : undefined;
  const catalogKey = readCatalogKey(descriptor);

  return {
    found: true,
    explanation: {
      command: descriptor.name,
      aliases: catalogKey === descriptor.name ? [] : [catalogKey],
      description:
        metadata?.description ??
        cliSchema?.helpDescription ??
        `Internal command ${descriptor.name}`,
      catalog: { group: descriptor.catalog.group, key: catalogKey },
      ...(family ? { family: family.name } : {}),
      ...('daemon' in descriptor && descriptor.daemon
        ? {
            daemon: {
              route: descriptor.daemon.route,
              traits: describeDaemonTraits(descriptor.daemon),
            },
          }
        : {}),
      ...('capability' in descriptor && descriptor.capability
        ? { capability: descriptor.capability }
        : {}),
      exposure: {
        batchable: descriptor.batchable,
        mcp: descriptor.mcpExposed,
        dispatch: 'dispatch' in descriptor && descriptor.dispatch !== undefined,
        ...('postActionObservation' in descriptor && descriptor.postActionObservation
          ? { postActionObservation: descriptor.postActionObservation }
          : {}),
      },
      timeout: describeTimeoutPolicy(descriptor.timeoutPolicy),
      ...(cliSchema ? { cli: describeCliSurface(descriptor.name, cliSchema) } : {}),
      files: commandFiles(
        descriptor.name,
        family?.name,
        'daemon' in descriptor ? descriptor.daemon?.route : undefined,
        Boolean('capability' in descriptor && descriptor.capability),
        options.fileExists,
      ),
    },
  };
}

export function formatCommandExplanation(explanation: CommandExplanation): string {
  const lines = [
    `${explanation.command} [${explanation.catalog.group}]`,
    explanation.description,
    `catalog: ${explanation.catalog.key}${explanation.aliases.length ? ` (alias: ${explanation.aliases.join(', ')})` : ''}`,
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
    lines.push(`supported: ${formatFlagList(explanation.cli.supportedFlags)}`);
    lines.push(`global: ${formatFlagList(explanation.cli.globalFlags)}`);
  }
  lines.push('files:', ...explanation.files.map((file) => `  ${file}`));
  return lines.join('\n');
}

function resolveDescriptor(query: string) {
  const direct = descriptorByName.get(query);
  if (direct) return direct;
  return commandDescriptors.find((descriptor) => readCatalogKey(descriptor) === query);
}

function readCatalogKey(descriptor: (typeof commandDescriptors)[number]): string {
  return 'key' in descriptor.catalog && descriptor.catalog.key
    ? descriptor.catalog.key
    : descriptor.name;
}

function suggestCommands(query: string): string[] {
  const candidates = commandDescriptors.flatMap((descriptor) => [
    descriptor.name,
    readCatalogKey(descriptor),
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
    usage: schema.usageOverride ?? command,
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
  family: string | undefined,
  daemonRoute: string | undefined,
  hasCapability: boolean,
  fileExists: FileExists | undefined,
): string[] {
  const candidates = ['src/core/command-descriptor/registry.ts'];
  if (family) {
    candidates.push(
      `src/commands/${family}/${command}.ts`,
      `src/commands/${family}/index.ts`,
      `src/commands/${family}/${command}.test.ts`,
      `src/commands/${family}/index.test.ts`,
    );
  } else if (cliCommandNames.has(command)) {
    candidates.push('src/utils/cli-command-overrides.ts');
  }
  if (daemonRoute) candidates.push(`src/daemon/handlers/${daemonRoute}.ts`);
  if (hasCapability) candidates.push('src/core/capabilities.ts');
  return [...new Set(fileExists ? candidates.filter(fileExists) : candidates)];
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
