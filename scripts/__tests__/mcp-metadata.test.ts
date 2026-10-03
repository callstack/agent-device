/**
 * Guard for the registry-format launch argument.
 *
 * The MCP registry entry (and the website's `/.well-known/mcp.json` discovery manifest) tell a
 * launcher how to start the server: the npm package, the stdio transport, and
 * `packageArguments`. Without the fixed `mcp` positional argument, a client that honors the
 * manifest runs `agent-device` with no subcommand — the bare CLI — instead of the stdio MCP
 * server (`src/bin.ts` only starts the server for the `mcp` subcommand).
 *
 * `check:mcp-metadata` compares the file against a regeneration, which proves the corrected file
 * is self-consistent; this test owns the invariant directly against the checked-in file and fails
 * in both directions — a missing argument and a wrong one.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

const EXPECTED_MCP_PACKAGE_ARGUMENTS = [{ type: 'positional', value: 'mcp' }];

type ServerPackage = {
  registryType?: string;
  identifier?: string;
  transport?: { type?: string };
  packageArguments?: unknown;
};

test('the published registry entry starts the MCP server, not the bare CLI', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    name: string;
  };
  const server = JSON.parse(await readFile(join(ROOT, 'server.json'), 'utf8')) as {
    packages?: ServerPackage[];
  };

  const entry = (server.packages ?? []).find((candidate) => candidate.identifier === pkg.name);
  assert.ok(entry, `server.json must describe the ${pkg.name} npm package`);
  assert.equal(entry.registryType, 'npm');
  assert.deepEqual(entry.transport, { type: 'stdio' });

  assert.deepEqual(
    entry.packageArguments,
    EXPECTED_MCP_PACKAGE_ARGUMENTS,
    'registry-format launchers must start the stdio MCP server; without the fixed mcp subcommand they run the bare CLI',
  );
});
