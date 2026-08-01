import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explainCommand, formatCommandExplanation } from '../src/commands/command-explain.ts';
import { getDaemonRouteOwnerFiles } from '../src/daemon/route-owner-files.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
export type ExplainCommandCliResult = {
  status: number;
  stdout: string;
  stderr: string;
};

/** @internal Exported so tests can exercise CLI behavior without starting a subprocess. */
export function runExplainCommandCli(args: string[], root = repoRoot): ExplainCommandCliResult {
  const json = args.includes('--json');
  const full = args.includes('--full');
  const query = args.find((arg) => arg !== '--json' && arg !== '--full');

  if (!query) {
    return {
      status: 1,
      stdout: '',
      stderr: 'Usage: pnpm explain:command <command-or-catalog-key> [--json] [--full]\n',
    };
  }
  const daemonRouteOwnerFiles = getDaemonRouteOwnerFiles();
  const result = explainCommand(query, {
    fileExists: (file) => fs.existsSync(path.join(root, file)),
    daemonRouteOwnerFiles,
  });
  if (!result.found) {
    const suffix =
      result.suggestions.length === 0 ? '' : ` Did you mean: ${result.suggestions.join(', ')}?`;
    return {
      status: 1,
      stdout: '',
      stderr: `Unknown command "${result.query}".${suffix}\n`,
    };
  }

  return {
    status: 0,
    stdout: json
      ? `${JSON.stringify(result.explanation, null, 2)}\n`
      : `${formatCommandExplanation(result.explanation, { detail: full ? 'full' : 'compact' })}\n`,
    stderr: '',
  };
}

function isMainModule(): boolean {
  return Boolean(
    process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
  );
}

if (isMainModule()) {
  const result = runExplainCommandCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
