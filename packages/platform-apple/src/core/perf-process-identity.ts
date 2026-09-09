import path from 'node:path';

export function matchesAppleExecutableProcess(
  command: string,
  executable: { executableName: string; executablePath?: string },
): boolean {
  const [token = ''] = command.trim().split(/\s+/, 1);
  if (executable.executablePath) {
    for (const executablePath of buildAppleExecutablePathAliases(executable.executablePath)) {
      if (
        command === executablePath ||
        token === executablePath ||
        command.startsWith(`${executablePath} `)
      ) {
        return true;
      }
    }
    return false;
  }
  return path.basename(token) === executable.executableName;
}

function buildAppleExecutablePathAliases(executablePath: string): string[] {
  const aliases = [executablePath];
  if (executablePath.startsWith('/private/var/')) {
    aliases.push(executablePath.replace('/private/var/', '/var/'));
  } else if (executablePath.startsWith('/var/')) {
    aliases.push(executablePath.replace('/var/', '/private/var/'));
  }
  return aliases;
}
