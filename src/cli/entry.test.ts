import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as cliHelp from '../cli-schema/cli-help.ts';
import { listCliCommandNames } from '../command-catalog.ts';
import { cliAliasesForCommand } from '../commands/cli-command-aliases.ts';
import { runEntry, type EntryModules } from './entry.ts';

const ALIASES = listCliCommandNames().flatMap((command) =>
  cliAliasesForCommand(command).map((entry) => [entry.alias, command] as const),
);

function harness(options: { bundledVersion?: string; cli?: EntryModules['cli'] } = {}) {
  const loaded: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cliArgv: string[][] = [];
  const exits: number[] = [];
  const modules: EntryModules = {
    help: async () => {
      loaded.push('help');
      return cliHelp;
    },
    cli:
      options.cli ??
      (async () => {
        loaded.push('cli');
        return {
          runCliProcess: async (argv) => {
            cliArgv.push(argv);
          },
        };
      }),
    mcp: async () => {
      loaded.push('mcp');
      return { runAgentDeviceMcpServer: async () => {} };
    },
    version: async () => {
      loaded.push('version');
      return { readVersion: () => '9.9.9-source' };
    },
    processExit: async () => ({
      exitAfterFlush: async (code) => {
        exits.push(code);
      },
    }),
  };
  const run = (argv: string[]) =>
    runEntry(argv, modules, {
      bundledVersion: options.bundledVersion,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
  return { run, loaded, stdout, stderr, cliArgv, exits };
}

test('every registered alias prints its canonical help without loading the CLI', async () => {
  assert.ok(ALIASES.length > 0);
  for (const [alias, canonical] of ALIASES) {
    const entry = harness();
    await entry.run([alias, '--help']);
    assert.equal(entry.stdout.join(''), cliHelp.buildCommandUsageText(canonical), alias);
    assert.deepEqual(entry.loaded, ['help'], alias);
  }
});

test('an unknown help topic falls through to the full CLI', async () => {
  const entry = harness();
  await entry.run(['rotate', '--help']);
  assert.deepEqual(entry.stdout, []);
  assert.deepEqual(entry.loaded, ['help', 'cli']);
  assert.deepEqual(entry.cliArgv, [['rotate', '--help']]);
});

test('--version prints the bundled version, or reads it when running from source', async () => {
  const bundled = harness({ bundledVersion: '1.2.3' });
  await bundled.run(['--version']);
  assert.deepEqual([bundled.stdout, bundled.loaded], [['1.2.3\n'], []]);

  const source = harness();
  await source.run(['-V']);
  assert.deepEqual([source.stdout, source.loaded], [['9.9.9-source\n'], ['version']]);
});

test('no command prints usage and exits 1 after flushing', async () => {
  const entry = harness();
  await entry.run([]);
  assert.equal(entry.stdout.join(''), `${cliHelp.buildUsageText()}\n`);
  assert.deepEqual(entry.exits, [1]);
});

test('mcp starts the server unless help is requested', async () => {
  const server = harness();
  await server.run(['mcp']);
  assert.deepEqual(server.loaded, ['mcp']);

  const help = harness();
  await help.run(['mcp', '--help']);
  assert.deepEqual(help.loaded, ['help']);
  assert.equal(help.stdout.join(''), cliHelp.buildCommandUsageText('mcp'));
});

test('a startup failure is reported on stderr and exits 1', async () => {
  const entry = harness({
    cli: async () => {
      throw new Error('boom');
    },
  });
  await entry.run(['press', 'Sign in']);
  assert.deepEqual(entry.stderr, ['boom\n']);
  assert.deepEqual(entry.exits, [1]);
});
