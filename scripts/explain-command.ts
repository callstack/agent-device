import fs from 'node:fs';
import path from 'node:path';
import { explainCommand, formatCommandExplanation } from '../src/commands/command-explain.ts';
import { getDaemonRouteOwnerFiles } from '../src/daemon/request-handler-chain.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
const full = args.includes('--full');
const query = args.find((arg) => arg !== '--json' && arg !== '--full');

if (!query) {
  process.stderr.write('Usage: pnpm explain:command <command-or-catalog-key> [--json] [--full]\n');
  process.exitCode = 1;
} else {
  const daemonRouteOwnerFiles = getDaemonRouteOwnerFiles();
  const result = explainCommand(query, {
    fileExists: (file) => fs.existsSync(path.join(repoRoot, file)),
    daemonRouteOwnerFiles,
  });
  if (!result.found) {
    const suffix =
      result.suggestions.length === 0 ? '' : ` Did you mean: ${result.suggestions.join(', ')}?`;
    process.stderr.write(`Unknown command "${result.query}".${suffix}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      json
        ? `${JSON.stringify(result.explanation, null, 2)}\n`
        : `${formatCommandExplanation(result.explanation, { detail: full ? 'full' : 'compact' })}\n`,
    );
  }
}
