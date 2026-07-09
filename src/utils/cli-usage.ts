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

export function buildCommandUsage(commandName: string, schema: CommandSchema): string {
  if (schema.usageOverride) return schema.usageOverride;
  const positionals = (schema.positionalArgs ?? []).map(formatPositionalArg);
  const flagLabels = (schema.allowedFlags ?? []).flatMap((key) =>
    flagDefinitionsForKey(key).map((definition) => definition.usageLabel ?? definition.names[0]),
  );
  const optionalFlags = flagLabels.map((label) => `[${label}]`);
  return [commandName, ...positionals, ...optionalFlags].join(' ');
}
