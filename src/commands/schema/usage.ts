import type { CommandSchema } from '@agent-device/command-registry/command-schema';
import { getFlagDefinitions } from '@agent-device/command-registry/flag-registry';
import type { FlagDefinition, FlagKey } from '@agent-device/command-registry/flag-types';

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
 * `usageHidden` option.
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

export function listHelpFlags(keys: ReadonlySet<FlagKey>): FlagDefinition[] {
  return getFlagDefinitions().filter(
    (definition) =>
      keys.has(definition.key) &&
      definition.usageLabel !== undefined &&
      definition.usageDescription !== undefined,
  );
}

// Command-specific override for a shared flag's help text (see CommandSchema.flagDescriptionOverrides):
// keeps the FlagDefinition registry as one shared row per flag while letting a command whose
// semantics genuinely differ (e.g. `replay --save-script` arms a repair transaction, not the
// open/close authoring lifecycle) show its own description without duplicating the flag entry.
function applyFlagDescriptionOverrides(
  definitions: FlagDefinition[],
  overrides: Partial<Record<FlagKey, string>> | undefined,
): FlagDefinition[] {
  if (!overrides) return definitions;
  return definitions.map((definition) => {
    const override = overrides[definition.key];
    return override === undefined ? definition : { ...definition, usageDescription: override };
  });
}

/** The options `agent-device help <command>` lists, with the command's own description overrides. */
export function commandHelpFlags(schema: CommandSchema): FlagDefinition[] {
  return applyFlagDescriptionOverrides(
    listHelpFlags(new Set<FlagKey>(schema.allowedFlags ?? [])),
    schema.flagDescriptionOverrides,
  );
}
