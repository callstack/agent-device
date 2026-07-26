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
