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
 * A find whose action is `exists`, the only read-only find: bare find clicks. `subject` must
 * appear in the query, which the optional locator precedes and the action follows.
 */
export function findExistsSource(subject = '') {
  const unquoted = subject ? String.raw`[^\s"']*${subject}[^\s"']*` : String.raw`[^\s"']+`;
  // A double-quoted query may hold escaped quotes, as the plan canonicalizer emits them.
  const doubleQuoted = String.raw`"(?:[^"\\\n]|\\.)*${subject}(?:[^"\\\n]|\\.)*"`;
  return String.raw`\bfind\s+(?:(?:text|label|value|role|id)\s+)?(?:${doubleQuoted}|'[^'\n]*${subject}[^'\n]*'|${unquoted})\s+exists(?:\s|$)`;
}
