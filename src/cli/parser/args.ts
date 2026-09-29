import type { CliFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { mergeDefinedFlags } from '../../commands/schema/merge-flags.ts';
import {
  assertCommandPositionalArity,
  getCommandSchema,
  getFlagDefinition,
  getFlagDefinitions,
  type FlagDefinition,
  type FlagKey,
} from '../../commands/schema/command-schema.ts';
import { isFlagSupportedForCommand } from '../../commands/schema/option-schema.ts';
import { applyCommandDefaults } from '@agent-device/command-registry/registry';
import { isKnownCliCommandName } from '@agent-device/command-registry/catalog';
import {
  cliCommandAlias,
  normalizeCliCommandAlias,
  retiredCliCommandMessage,
} from '@agent-device/command-registry/cli-command-aliases';
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
  const state: RawParseState = {
    command: null,
    flags: { json: false, help: false, version: false },
    parseFlags: true,
    positionals: [],
    providedFlags: [],
    rawCommand: null,
    warnings: [],
  };
  for (let index = 0; index < argv.length; index += parseRawArgument(state, argv, index) + 1) {
    // parseRawArgument returns one extra consumed argument when a value follows its flag.
  }
  applyAliasImpliedFlags(state.rawCommand, state.flags);
  return state;
}

type RawParseState = RawParsedArgs & { rawCommand: string | null; parseFlags: boolean };

function parseRawArgument(state: RawParseState, argv: string[], index: number): number {
  const arg = argv[index]!;
  if (arg === '--' && state.parseFlags) {
    state.parseFlags = false;
    return 0;
  }
  if (appendRawPositional(state, arg)) return 0;
  return parseRawFlag(state, arg, argv[index + 1]);
}

function appendRawPositional(state: RawParseState, arg: string): boolean {
  if (!state.parseFlags || shouldPreservePostCommandArgs(state.command) || !isFlagToken(arg)) {
    if (!state.command) {
      state.rawCommand = arg;
      state.command = normalizeCommandAlias(arg);
    } else {
      state.positionals.push(arg);
    }
    return true;
  }
  return false;
}

function isFlagToken(arg: string): boolean {
  return arg.startsWith('--') || (arg.startsWith('-') && arg.length > 1);
}

function parseRawFlag(state: RawParseState, arg: string, nextArg: string | undefined): number {
  const [token, inlineValue] = arg.startsWith('--') ? splitLongFlag(arg) : [arg, undefined];
  if (isLegacyIgnoredSnapshotShortFlag(state.command, token)) return 0;
  const definition = resolveFlagDefinition(token, state.command);
  if (shouldPassThroughLocalToolFlag(state.command, definition)) {
    state.positionals.push(arg);
    return 0;
  }
  if (!definition) return parseUnknownRawFlag(state, token, arg);
  const parsed = parseFlagValue(definition, token, inlineValue, nextArg);
  appendParsedFlag(state, definition, token, parsed.value);
  return Number(parsed.consumeNext);
}

function parseUnknownRawFlag(state: RawParseState, token: string, arg: string): number {
  if (shouldTreatUnknownDashTokenAsPositional(state.command, state.positionals, arg)) {
    if (!state.command) state.command = arg;
    else state.positionals.push(arg);
    return 0;
  }
  throw new AppError('INVALID_ARGS', formatUnknownFlagMessage(token, state.command));
}

function appendParsedFlag(
  state: RawParseState,
  definition: FlagDefinition,
  token: string,
  value: unknown,
): void {
  const flags = state.flags as Record<string, unknown>;
  const existingValue = flags[definition.key];
  flags[definition.key] = definition.multiple
    ? appendMultipleFlagValue(existingValue, value)
    : value;
  state.providedFlags.push({ key: definition.key, token });
}

function appendMultipleFlagValue(existingValue: unknown, value: unknown): unknown[] {
  if (Array.isArray(existingValue)) return [...existingValue, value];
  if (existingValue === undefined) return [value];
  return [existingValue, value];
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

  const unread = findFlagsTheActionCannotRead(parsed);
  if (unread.length > 0) {
    const message = formatUnreadActionFlagMessage(parsed.command, parsed.positionals[0]!, unread);
    if (strictFlags) {
      throw new AppError('INVALID_ARGS', message);
    }
    warnings.push(message);
    for (const entry of unread) {
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
  const normalized = normalizeParsedCommandAliases({
    command: parsed.command,
    positionals: parsed.positionals,
    flags,
    warnings,
  });
  assertCommandPositionalArity(normalized.command, normalized.positionals);
  if (normalized.command === 'batch') {
    const stepSourceCount = (flags.steps ? 1 : 0) + (flags.stepsFile ? 1 : 0);
    if (stepSourceCount !== 1) {
      throw new AppError(
        'INVALID_ARGS',
        'batch requires exactly one step source: --steps or --steps-file.',
      );
    }
  }
  return normalized;
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
  if (definition.setValue !== undefined) return parseSetValue(definition, token, inlineValue);
  if (definition.type === 'boolean') return parseBooleanValue(token, inlineValue);
  if (definition.type === 'booleanOrString') {
    return parseBooleanOrStringValue(token, inlineValue, nextArg);
  }
  return parseRequiredFlagValue(definition, token, inlineValue, nextArg);
}

function parseSetValue(
  definition: FlagDefinition,
  token: string,
  inlineValue: string | undefined,
): { value: unknown; consumeNext: boolean } {
  assertNoInlineValue(token, inlineValue);
  return { value: definition.setValue, consumeNext: false };
}

function parseBooleanValue(
  token: string,
  inlineValue: string | undefined,
): { value: unknown; consumeNext: boolean } {
  assertNoInlineValue(token, inlineValue);
  return { value: true, consumeNext: false };
}

function assertNoInlineValue(token: string, inlineValue: string | undefined): void {
  if (inlineValue !== undefined) {
    throw new AppError('INVALID_ARGS', `Flag ${token} does not take a value.`);
  }
}

function parseBooleanOrStringValue(
  token: string,
  inlineValue: string | undefined,
  nextArg: string | undefined,
): { value: unknown; consumeNext: boolean } {
  if (inlineValue !== undefined) return parseInlineBooleanOrString(token, inlineValue);
  if (nextArg === undefined || looksLikeFlagToken(nextArg)) {
    return { value: true, consumeNext: false };
  }
  return shouldConsumeOptionalPathValue(nextArg)
    ? { value: nextArg, consumeNext: true }
    : { value: true, consumeNext: false };
}

function parseInlineBooleanOrString(
  token: string,
  value: string,
): { value: unknown; consumeNext: boolean } {
  if (value.trim().length === 0) {
    throw new AppError('INVALID_ARGS', `Flag ${token} requires a non-empty value when provided.`);
  }
  return { value, consumeNext: false };
}

function parseRequiredFlagValue(
  definition: FlagDefinition,
  token: string,
  inlineValue: string | undefined,
  nextArg: string | undefined,
): { value: unknown; consumeNext: boolean } {
  const value = inlineValue ?? nextArg;
  assertRequiredFlagValue(token, value, inlineValue);
  if (definition.type === 'string') return { value, consumeNext: inlineValue === undefined };
  if (definition.type === 'enum') {
    return parseEnumFlagValue(definition, token, value, inlineValue === undefined);
  }
  return parseNumericFlagValue(definition, token, value, inlineValue === undefined);
}

function assertRequiredFlagValue(
  token: string,
  value: string | undefined,
  inlineValue: string | undefined,
): asserts value is string {
  if (value === undefined || (inlineValue === undefined && looksLikeFlagToken(value))) {
    throw new AppError('INVALID_ARGS', `Flag ${token} requires a value.`);
  }
}

function parseEnumFlagValue(
  definition: FlagDefinition,
  token: string,
  value: string,
  consumeNext: boolean,
): { value: unknown; consumeNext: boolean } {
  if (!definition.enumValues?.includes(value)) {
    throw new AppError('INVALID_ARGS', `Invalid ${labelForFlag(token)}: ${value}`);
  }
  return { value, consumeNext };
}

function parseNumericFlagValue(
  definition: FlagDefinition,
  token: string,
  value: string,
  consumeNext: boolean,
): { value: unknown; consumeNext: boolean } {
  const parsed = Number(value);
  if (value.trim().length === 0 || !Number.isFinite(parsed)) {
    return invalidNumericFlagValue(token, value);
  }
  assertNumericBounds(definition, token, value, parsed);
  return {
    value: definition.type === 'int' ? Math.floor(parsed) : parsed,
    consumeNext,
  };
}

function invalidNumericFlagValue(token: string, value: string): never {
  throw new AppError('INVALID_ARGS', `Invalid ${labelForFlag(token)}: ${value}`);
}

function assertNumericBounds(
  definition: FlagDefinition,
  token: string,
  value: string,
  parsed: number,
): void {
  if (typeof definition.min === 'number' && parsed < definition.min) {
    invalidNumericFlagValue(token, value);
  }
  if (typeof definition.max === 'number' && parsed > definition.max) {
    invalidNumericFlagValue(token, value);
  }
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

/**
 * The typed options the selected action of a command cannot read.
 *
 * Only the options the table splits across actions are its business: a global flag such as `--json`
 * or `--no-record` is read by every action, and refusing one would refuse the command itself. A
 * command without the table, or an action it does not list, is left to the rest of the parser.
 *
 * Config, env, and remote-config defaults never appear in `providedFlags`, which is why
 * `AGENT_DEVICE_FPS=30` does not fail `record stop`: a default the action ignores was never requested.
 */
function findFlagsTheActionCannotRead(parsed: RawParsedArgs): ParsedFlagRecord[] {
  const flagsByAction = getCommandSchema(parsed.command)?.flagsByAction;
  const action = parsed.positionals[0];
  if (flagsByAction === undefined || action === undefined) return [];
  if (!Object.hasOwn(flagsByAction, action)) return [];
  const reads = flagsByAction[action];
  if (reads === undefined) return [];
  const actionScoped = new Set(Object.values(flagsByAction).flat());
  return parsed.providedFlags.filter(
    (entry) => actionScoped.has(entry.key) && !reads.includes(entry.key),
  );
}

function formatUnreadActionFlagMessage(
  command: string | null,
  action: string,
  unread: ParsedFlagRecord[],
): string {
  const tokens = unread.map((entry) => entry.token).join(', ');
  return `${command} ${action} does not read ${tokens}. Run \`${command} ${action} --help\` for the options it reads.`;
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
  const { buildUsageText } = await import('../../commands/schema/cli-help.ts');
  return buildUsageText();
}

export async function usageForCommand(command: string): Promise<string | null> {
  const { buildCommandUsageText } = await import('../../commands/schema/cli-help.ts');
  return buildCommandUsageText(normalizeCommandAlias(command));
}

function normalizeCommandAlias(command: string): string {
  const retiredMessage = retiredCliCommandMessage(command);
  if (retiredMessage) throw new AppError('INVALID_ARGS', retiredMessage);
  return normalizeCliCommandAlias(command);
}
