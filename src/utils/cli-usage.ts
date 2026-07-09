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
 * Canonical single-line usage for a command, shared by CLI `--help` rendering
 * and `explain`. Honors an explicit `usageOverride`; otherwise composes
 * `<command> <positionals> [flags]` from the schema so callers without an
 * override still surface positionals and flags rather than the bare name.
 */
export function buildCommandUsage(commandName: string, schema: CommandSchema): string {
  if (schema.usageOverride) return schema.usageOverride;
  const positionals = (schema.positionalArgs ?? []).map(formatPositionalArg);
  const flagLabels = (schema.allowedFlags ?? []).flatMap((key) =>
    flagDefinitionsForKey(key).map((definition) => definition.usageLabel ?? definition.names[0]),
  );
  const optionalFlags = flagLabels.map((label) => `[${label}]`);
  return [commandName, ...positionals, ...optionalFlags].join(' ');
}
