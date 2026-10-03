import {
  getFlagDefinitions,
  type CommandSchema,
  type FlagDefinition,
  type FlagKey,
} from './command-schema.ts';

function formatPositionalArg(arg: string): string {
  const optional = arg.endsWith('?');
  const name = optional ? arg.slice(0, -1) : arg;
  return optional ? `[${name}]` : `<${name}>`;
}

function flagDefinitionsForKey(key: FlagKey): FlagDefinition[] {
  return getFlagDefinitions().filter((definition) => definition.key === key);
}

/**
 * An option's synopsis token is its `usageLabel`, else its first CLI name: nothing for a
 * `usageHidden` option, or one with no CLI name at all (a config-only virtual option).
 */
function usageToken(definition: FlagDefinition): string | undefined {
  if (definition.usageHidden) return undefined;
  return definition.usageLabel ?? definition.names[0];
}

function buildFlagTail(allowedFlags: readonly FlagKey[] | undefined): string[] {
  return (allowedFlags ?? []).flatMap((key) =>
    flagDefinitionsForKey(key)
      .map(usageToken)
      .filter((token): token is string => token !== undefined)
      .map((token) => `[${token}]`),
  );
}

export function buildCommandUsage(commandName: string, schema: CommandSchema): string {
  const grammar =
    schema.usageOverride ??
    [commandName, ...(schema.positionalArgs ?? []).map(formatPositionalArg)].join(' ');
  return [grammar, ...buildFlagTail(schema.usageFlags ?? schema.allowedFlags)].join(' ');
}
