import { pathToFileURL } from 'node:url';
import { parseArgs } from '../src/cli/parser/args.ts';
import { readInputFromCli } from '../src/commands/cli-grammar.ts';
import { isCommandName } from '../src/commands/command-metadata.ts';

type ValidationKind = 'agent-device-grammar' | 'pseudo-ref';

type ParsedAgentCommand = {
  command: string;
  positionals: string[];
};

type ValidationResult = { valid: true } | { valid: false; kind: ValidationKind; error: string };
type PlanValidationResult = ValidationResult & { agentCommand?: ParsedAgentCommand };

const TARGET_POSITION_BY_COMMAND = new Map<string, number>([
  ['click', 0],
  ['fill', 0],
  ['get', 1],
  ['longpress', 0],
  ['press', 0],
  ['wait', 0],
]);
const POSITIONAL_AT_REFS_ARE_INVALID = new Set(['focus', 'scroll', 'swipe']);
const CONCRETE_REF = /^@[ec]\d+(?:~s\d+)?$/;

export function validateAgentDeviceCommand(value: unknown): ValidationResult {
  if (!isStringArray(value) || value.length === 0) {
    return invalid('agent-device-grammar', 'Expected a non-empty string argv array.');
  }

  try {
    return validateParsedCommand(parseArgs(value, { strictFlags: true }));
  } catch (error) {
    return invalid('agent-device-grammar', error instanceof Error ? error.message : String(error));
  }
}

function validateParsedCommand(parsed: ReturnType<typeof parseArgs>): ValidationResult {
  if (!parsed.command) return validateGlobalFlags(parsed.flags);

  const pseudoRef = targetRefCandidate(parsed.command, parsed.positionals);
  if (pseudoRef && !CONCRETE_REF.test(pseudoRef)) {
    return invalid('pseudo-ref', `Pseudo ref "${pseudoRef}" is not an observed @eN or @cN ref.`);
  }

  if (isCommandName(parsed.command)) {
    readInputFromCli(parsed.command, parsed.positionals, parsed.flags);
  }
  return { valid: true };
}

function validateGlobalFlags(flags: ReturnType<typeof parseArgs>['flags']): ValidationResult {
  return flags.version || flags.help
    ? { valid: true }
    : invalid('agent-device-grammar', 'Missing command.');
}

function targetRefCandidate(command: string, positionals: string[]): string | undefined {
  const targetPosition = TARGET_POSITION_BY_COMMAND.get(command);
  if (targetPosition !== undefined) {
    const candidate = positionals[targetPosition];
    return candidate?.startsWith('@') ? candidate : undefined;
  }
  if (command === 'is') return positionals.find((positional) => positional.startsWith('@'));
  if (POSITIONAL_AT_REFS_ARE_INVALID.has(command)) {
    return positionals.find((positional) => positional.startsWith('@'));
  }
  return undefined;
}

function invalid(kind: ValidationKind, error: string): ValidationResult {
  return { valid: false, kind, error };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function validateInput(value: unknown): PlanValidationResult | PlanValidationResult[] {
  if (Array.isArray(value) && value.every(isStringArray)) return value.map(validatePlanCommand);
  return validatePlanCommand(value);
}

function validatePlanCommand(value: unknown): PlanValidationResult {
  const validation = validateAgentDeviceCommand(value);
  if (!validation.valid || !isStringArray(value)) return validation;
  const parsed = parseArgs(value, { strictFlags: true });
  if (!parsed.command) return validation;
  return {
    ...validation,
    agentCommand: {
      command: parsed.command,
      positionals: [...parsed.positionals],
    },
  };
}

function runCli(): void {
  const encodedInput = process.argv[2];
  if (!encodedInput) throw new Error('Expected a JSON argv array.');
  process.stdout.write(JSON.stringify(validateInput(JSON.parse(encodedInput))));
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) runCli();
