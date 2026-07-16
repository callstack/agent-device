import { AppError } from '../../kernel/errors.ts';
import { mergeDefinedFlags } from '../../utils/merge-flags.ts';
import {
  applyCommandDefaults,
  getCommandSchema,
  getFlagDefinition,
  getFlagDefinitions,
  type CliFlags,
  type FlagDefinition,
  type FlagKey,
} from '../../cli-schema/command-schema.ts';
import { isFlagSupportedForCommand } from '../../cli-schema/option-schema.ts';
import { isKnownCliCommandName } from '../../command-catalog.ts';
import { cliCommandAlias, normalizeCliCommandAlias } from '../../cli-command-aliases.ts';
import { formatUnknownFlagMessage, suggestCommandFor } from './command-suggestions.ts';

type ParsedArgs = {
  command: string | null;
  positionals: string[];
  flags: CliFlags;
  warnings: string[];
};

type ParseArgsOptions = {
  strictFlags?: boolean;
};

type ParsedFlagRecord = {
  key: FlagKey;
  token: string;
};

type RawParsedArgs = ParsedArgs & {
  providedFlags: ParsedFlagRecord[];
};

type FinalizeArgsOptions = ParseArgsOptions & {
  defaultFlags?: Partial<CliFlags>;
};

/**
 * @internal High-level argv parser used by unit tests and build scripts.
 */
export function parseArgs(argv: string[], options?: FinalizeArgsOptions): ParsedArgs {
  return finalizeParsedArgs(parseRawArgs(argv), options);
}

export function parseRawArgs(argv: string[]): RawParsedArgs {
  const flags: CliFlags = { json: false, help: false, version: false };
  let command: string | null = null;
  let rawCommand: string | null = null;
  const positionals: string[] = [];
  const warnings: string[] = [];
  const providedFlags: ParsedFlagRecord[] = [];
  let parseFlags = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (parseFlags && arg === '--') {
      parseFlags = false;
      continue;
    }
    if (!parseFlags) {
      if (!command) {
        rawCommand = arg;
        command = normalizeCommandAlias(arg);
      } else positionals.push(arg);
      continue;
    }
    if (shouldPreservePostCommandArgs(command)) {
      positionals.push(arg);
      continue;
    }
    const isLongFlag = arg.startsWith('--');
    const isShortFlag = arg.startsWith('-') && arg.length > 1;
    if (!isLongFlag && !isShortFlag) {
      if (!command) {
        rawCommand = arg;
        command = normalizeCommandAlias(arg);
      } else positionals.push(arg);
      continue;
    }

    const [token, inlineValue] = isLongFlag ? splitLongFlag(arg) : [arg, undefined];
    if (isLegacyIgnoredSnapshotShortFlag(command, token)) {
      continue;
    }
    const definition = resolveFlagDefinition(token, command);
    if (shouldPassThroughLocalToolFlag(command, definition)) {
      positionals.push(arg);
      continue;
    }
    if (!definition) {
      if (shouldTreatUnknownDashTokenAsPositional(command, positionals, arg)) {
        if (!command) command = arg;
        else positionals.push(arg);
        continue;
      }
      throw new AppError('INVALID_ARGS', formatUnknownFlagMessage(token));
    }

    const parsed = parseFlagValue(definition, token, inlineValue, argv[i + 1]);
    if (parsed.consumeNext) i += 1;
    const existingValue = (flags as Record<string, unknown>)[definition.key];
    if (definition.multiple) {
      const values = Array.isArray(existingValue)
        ? [...existingValue, parsed.value]
        : existingValue === undefined
          ? [parsed.value]
          : [existingValue, parsed.value];
      (flags as Record<string, unknown>)[definition.key] = values;
    } else {
      (flags as Record<string, unknown>)[definition.key] = parsed.value;
    }
    providedFlags.push({ key: definition.key, token });
  }

  applyAliasImpliedFlags(rawCommand, flags);
  return { command, positionals, flags, warnings, providedFlags };
}

function applyAliasImpliedFlags(rawCommand: string | null, flags: CliFlags): void {
  if (!rawCommand) return;
  for (const key of cliCommandAlias(rawCommand)?.impliedFlags ?? []) {
    flags[key] = true;
  }
}

function isLegacyIgnoredSnapshotShortFlag(command: string | null, token: string): boolean {
  return token === '-c' && (command === 'snapshot' || command === 'diff');
}

function shouldPassThroughLocalToolFlag(
  command: string | null,
  definition: FlagDefinition | undefined,
): boolean {
  if (command !== 'react-devtools') return false;
  if (!definition) return true;
  return !isFlagSupportedForCommand(definition.key, command);
}

function shouldPreservePostCommandArgs(command: string | null): boolean {
  return command === 'cdp';
}

function resolveFlagDefinition(token: string, command: string | null): FlagDefinition | undefined {
  const definitions = getFlagDefinitions().filter((definition) => definition.names.includes(token));
  if (definitions.length <= 1) return definitions[0] ?? getFlagDefinition(token);
  if (command) {
    const commandDefinition = definitions.find((definition) =>
      isFlagSupportedForCommand(definition.key, command),
    );
    if (commandDefinition) return commandDefinition;
  }
  return getFlagDefinition(token);
}

export function finalizeParsedArgs(
  parsed: RawParsedArgs,
  options?: FinalizeArgsOptions,
): ParsedArgs {
  const strictFlags = options?.strictFlags ?? true;
  const warnings = [...parsed.warnings];
  const flags = mergeDefinedFlags(
    { json: false, help: false, version: false } as CliFlags,
    options?.defaultFlags ?? {},
  );
  mergeDefinedFlags(flags, parsed.flags);

  // Check if the command is known before validating flags
  // This ensures "Unknown command" errors take precedence over flag validation errors
  // However, skip this check if --help is provided, since cli.ts will handle it gracefully
  if (parsed.command && !isKnownCliCommandName(parsed.command) && !flags.help) {
    const hint = suggestCommandFor(parsed.command);
    const message = hint
      ? `Unknown command: ${parsed.command}. Did you mean ${hint}?`
      : `Unknown command: ${parsed.command}`;
    throw new AppError('INVALID_ARGS', message);
  }

  const disallowed = parsed.providedFlags.filter(
    (entry) => !isFlagSupportedForCommand(entry.key, parsed.command),
  );
  if (disallowed.length > 0) {
    const unsupported = disallowed.map((entry) => entry.token);
    const message = formatUnsupportedFlagMessage(parsed.command, unsupported);
    if (strictFlags) {
      throw new AppError('INVALID_ARGS', message);
    }
    warnings.push(message);
    for (const entry of disallowed) {
      delete (flags as Record<string, unknown>)[entry.key];
    }
  }
  for (const key of Object.keys(flags) as FlagKey[]) {
    if (flags[key] === undefined) continue;
    if (!isFlagSupportedForCommand(key, parsed.command)) {
      delete (flags as Record<string, unknown>)[key];
    }
  }
  assertNoConflictingBackModeFlags(parsed);
  applyCommandDefaults(parsed.command, flags);
  if (parsed.command === 'batch') {
    const stepSourceCount = (flags.steps ? 1 : 0) + (flags.stepsFile ? 1 : 0);
    if (stepSourceCount !== 1) {
      throw new AppError(
        'INVALID_ARGS',
        'batch requires exactly one step source: --steps or --steps-file.',
      );
    }
  }
  return normalizeParsedCommandAliases({
    command: parsed.command,
    positionals: parsed.positionals,
    flags,
    warnings,
  });
}

function assertNoConflictingBackModeFlags(parsed: RawParsedArgs): void {
  if (parsed.command !== 'back') return;
  const providedBackModeFlags = parsed.providedFlags.filter((entry) => entry.key === 'backMode');
  const distinctTokens = new Set(providedBackModeFlags.map((entry) => entry.token));
  if (distinctTokens.size <= 1) return;
  throw new AppError(
    'INVALID_ARGS',
    'back accepts only one explicit mode flag: use either --in-app or --system.',
  );
}

function splitLongFlag(flag: string): [string, string | undefined] {
  const equals = flag.indexOf('=');
  if (equals === -1) return [flag, undefined];
  return [flag.slice(0, equals), flag.slice(equals + 1)];
}

function parseFlagValue(
  definition: FlagDefinition,
  token: string,
  inlineValue: string | undefined,
  nextArg: string | undefined,
): { value: unknown; consumeNext: boolean } {
  if (definition.setValue !== undefined) {
    if (inlineValue !== undefined) {
      throw new AppError('INVALID_ARGS', `Flag ${token} does not take a value.`);
    }
    return { value: definition.setValue, consumeNext: false };
  }
  if (definition.type === 'boolean') {
    if (inlineValue !== undefined) {
      throw new AppError('INVALID_ARGS', `Flag ${token} does not take a value.`);
    }
    return { value: true, consumeNext: false };
  }
  if (definition.type === 'booleanOrString') {
    if (inlineValue !== undefined) {
      if (inlineValue.trim().length === 0) {
        throw new AppError(
          'INVALID_ARGS',
          `Flag ${token} requires a non-empty value when provided.`,
        );
      }
      return { value: inlineValue, consumeNext: false };
    }
    if (nextArg === undefined || looksLikeFlagToken(nextArg)) {
      return { value: true, consumeNext: false };
    }
    if (shouldConsumeOptionalPathValue(nextArg)) {
      return { value: nextArg, consumeNext: true };
    }
    return { value: true, consumeNext: false };
  }

  const value = inlineValue ?? nextArg;
  if (value === undefined) {
    throw new AppError('INVALID_ARGS', `Flag ${token} requires a value.`);
  }
  if (inlineValue === undefined && looksLikeFlagToken(value)) {
    throw new AppError('INVALID_ARGS', `Flag ${token} requires a value.`);
  }

  if (definition.type === 'string') {
    return { value, consumeNext: inlineValue === undefined };
  }
  if (definition.type === 'enum') {
    if (!definition.enumValues?.includes(value)) {
      throw new AppError('INVALID_ARGS', `Invalid ${labelForFlag(token)}: ${value}`);
    }
    return { value, consumeNext: inlineValue === undefined };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError('INVALID_ARGS', `Invalid ${labelForFlag(token)}: ${value}`);
  }
  if (typeof definition.min === 'number' && parsed < definition.min) {
    throw new AppError('INVALID_ARGS', `Invalid ${labelForFlag(token)}: ${value}`);
  }
  if (typeof definition.max === 'number' && parsed > definition.max) {
    throw new AppError('INVALID_ARGS', `Invalid ${labelForFlag(token)}: ${value}`);
  }
  return { value: Math.floor(parsed), consumeNext: inlineValue === undefined };
}

function labelForFlag(token: string): string {
  return token.replace(/^-+/, '');
}

function looksLikeFlagToken(value: string): boolean {
  if (!value.startsWith('-') || value === '-') return false;
  const [token] = value.startsWith('--') ? splitLongFlag(value) : [value, undefined];
  return getFlagDefinition(token) !== undefined;
}

function shouldConsumeOptionalPathValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return false;
  if (
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('/')
  ) {
    return true;
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) return true;
  return false;
}

function shouldTreatUnknownDashTokenAsPositional(
  command: string | null,
  positionals: string[],
  arg: string,
): boolean {
  if (!isNegativeNumericToken(arg)) return false;
  if (!command) return false;
  const schema = getCommandSchema(command);
  if (!schema) return true;
  if (schema.allowsExtraPositionals) return true;
  const positionalArgs = schema.positionalArgs ?? [];
  if (positionalArgs.length === 0) return false;
  if (positionals.length < positionalArgs.length) return true;
  return positionalArgs.some((entry) => entry.includes('?'));
}

function isNegativeNumericToken(value: string): boolean {
  return /^-\d+(\.\d+)?$/.test(value);
}

function normalizeParsedCommandAliases(parsed: ParsedArgs): ParsedArgs {
  if (parsed.flags.help) {
    return parsed;
  }
  if (parsed.command === 'snapshot' && parsed.flags.snapshotDiff) {
    const { snapshotDiff: _snapshotDiff, ...remainingFlags } = parsed.flags;
    return {
      command: 'diff',
      positionals: ['snapshot', ...parsed.positionals],
      flags: remainingFlags as CliFlags,
      warnings: parsed.warnings,
    };
  }
  return parsed;
}

function formatUnsupportedFlagMessage(command: string | null, unsupported: string[]): string {
  if (!command) {
    return unsupported.length === 1
      ? `Flag ${unsupported[0]} requires a command that supports it.`
      : `Flags ${unsupported.join(', ')} require a command that supports them.`;
  }
  return unsupported.length === 1
    ? `Flag ${unsupported[0]} is not supported for command ${command}.`
    : `Flags ${unsupported.join(', ')} are not supported for command ${command}.`;
}

// Usage text lives in cli-help.ts, which pulls the full command schema surface.
// Callers load it lazily so plain command invocations never parse the help text.
export async function usage(): Promise<string> {
  const { buildUsageText } = await import('./cli-help.ts');
  return buildUsageText();
}

export async function usageForCommand(command: string): Promise<string | null> {
  const { buildCommandUsageText } = await import('./cli-help.ts');
  return buildCommandUsageText(normalizeCommandAlias(command));
}

function normalizeCommandAlias(command: string): string {
  return normalizeCliCommandAlias(command);
}
