import { parseFindArgs } from '@agent-device/selectors';

export function opensAndCloses({ commands }) {
  return hasAgentDeviceCommand(commands, 'open') && hasAgentDeviceCommand(commands, 'close');
}

export function usesValidationPrep({ commands }) {
  const buildIndex = commands.findIndex(isSupportedBuildCommand);
  if (buildIndex < 0) return false;
  return commands.slice(buildIndex + 1).some((command) => isPnpmScript(command, 'clean:daemon'));
}

function hasAgentDeviceCommand(commands, command) {
  return commands.some((line) => new RegExp(`^agent-device\\s+${command}(?:\\s|$)`).test(line));
}

function isSupportedBuildCommand(command) {
  return isPnpmScript(command, 'build') || isPnpmScript(command, 'build:android');
}

function isPnpmScript(command, script) {
  return new RegExp(`^pnpm\\s+(?:run\\s+)?${script}(?:\\s|$)`).test(command ?? '');
}

/**
 * Whether the plan holds a read-only `find`: one whose action is `exists` (bare find clicks).
 * `parseFindArgs` owns the find grammar; `subject`, when given, must appear in the query.
 */
export function hasFindExists(commandValidation, subject) {
  return commandValidation.some((command) => {
    const positionals = findPositionals(command);
    if (!positionals) return false;
    const { action, query } = parseFindArgs(positionals);
    return action === 'exists' && (subject === undefined || query.toLowerCase().includes(subject));
  });
}

/** A find command's positionals: parsed when it validated, else its tokens without flags. */
function findPositionals({ tokens, agentCommand }) {
  if (agentCommand) return agentCommand.command === 'find' ? agentCommand.positionals : undefined;
  if (tokens[0] !== 'agent-device' || tokens[1] !== 'find') return undefined;
  return tokens.slice(2).filter((token) => !token.startsWith('-'));
}
