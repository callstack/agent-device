// `pnpm gate <check-id> [args…]` — the only way CI may run a gate.
//
// The run-gate action calls this with a structural id. The manifest reads that YAML field,
// never this command's surrounding shell. Raw workflow shell may still invoke this CLI, but
// doing so declares no ownership.
//
// Extra arguments are forwarded verbatim, so lane-specific flags (`--base`,
// `--udid`, `--report-junit`) stay in the workflow where they belong.

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { runCmdStreaming, runCmdSync } from '../../src/utils/exec.ts';
import { runEntrypoint } from '../lib/cli-entrypoint.ts';
import { CHECK_CATALOG, resolveCommand } from '../check-affected/checks.ts';

const USAGE = 'Usage: pnpm gate <check-id> [args…]\n';

export function resolveGate(
  id: string,
  scripts: Readonly<Record<string, string>>,
  args: readonly string[],
): string[] {
  // `pnpm gate x -- --flag` and `pnpm gate x --flag` both forward `--flag`.
  const extra = args[0] === '--' ? args.slice(1) : args;
  const spec = CHECK_CATALOG.find((entry) => entry.id === id);
  if (!spec) {
    const known = CHECK_CATALOG.map((entry) => entry.id).join(', ');
    throw new Error(`Unknown gate "${id}".\nRegistered gates: ${known}`);
  }
  const command = resolveCommand(spec, scripts, 'origin/main');
  // `fallow` carries a default --base; a lane that supplies its own replaces it
  // rather than passing the flag twice.
  const injected = extra.includes('--base') ? command.indexOf('--base') : -1;
  const resolved =
    injected === -1 ? command : [...command.slice(0, injected), ...command.slice(injected + 2)];
  return [...resolved, ...extra];
}

async function main(argv: readonly string[]): Promise<number> {
  const [id, ...rest] = argv;
  if (!id || id === '--help') {
    process.stdout.write(USAGE);
    return id ? 0 : 1;
  }
  const repoRoot = runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const command = resolveGate(id, pkg.scripts, rest);
  process.stdout.write(`[gate] ${id}: ${command.join(' ')}\n`);
  const result = await runCmdStreaming(command[0] as string, command.slice(1), {
    cwd: repoRoot,
    allowFailure: true,
    onStdoutChunk: (chunk) => void process.stdout.write(chunk),
    onStderrChunk: (chunk) => void process.stderr.write(chunk),
  });
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runEntrypoint('gate', () => main(process.argv.slice(2)));
}
