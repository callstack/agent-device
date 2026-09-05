import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';
import { cliAliasesForCommand } from '../../src/commands/cli-command-aliases.ts';
import { listCliCommandNames } from '../../src/command-catalog.ts';

// Derived from the alias registry itself (not hard-coded) so a future alias is
// exercised automatically, and so a partial hand-written mapping that covers only
// today's aliases cannot silently regain a fast-path gap for an alias added later.
const KNOWN_ALIASES: ReadonlyArray<readonly [string, string]> = listCliCommandNames().flatMap(
  (command) => cliAliasesForCommand(command).map((entry) => [entry.alias, command] as const),
);

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = runCmdSync(
    process.execPath,
    ['--experimental-strip-types', 'src/bin.ts', ...args],
    { allowFailure: true },
  );
  return { status: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// `runCli` (src/bin.ts) reaches the full CLI bootstrap only through one dynamic import:
// `runCli(argv)` -> `import('./cli/process-entry.ts')`. The --help fast path never reaches
// it. That makes this file's own coverage report (collected via NODE_V8_COVERAGE on the
// subprocess) an independent, byte-output-blind signal for which path actually ran: a
// reintroduced hand-written alias table in bin.ts, or a `resolveHelpTargetUsageText` that
// returns null for a real alias, falls through to `runCli` and flips this from false to
// true even though stdout would stay byte-identical to the canonical command's --help.
const PROCESS_ENTRY_MARKER = 'src/cli/process-entry.ts';

function runCliTrackingCoverage(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
  bootstrappedFullCli: boolean;
} {
  const coverageDir = mkdtempSync(join(tmpdir(), 'agent-device-cli-coverage-'));
  try {
    const result = runCmdSync(
      process.execPath,
      ['--experimental-strip-types', 'src/bin.ts', ...args],
      { allowFailure: true, env: { ...process.env, NODE_V8_COVERAGE: coverageDir } },
    );
    const bootstrappedFullCli = readdirSync(coverageDir).some((file) => {
      const report = JSON.parse(readFileSync(join(coverageDir, file), 'utf8')) as {
        result: Array<{ url: string }>;
      };
      return report.result.some((entry) => entry.url.includes(PROCESS_ENTRY_MARKER));
    });
    return {
      status: result.exitCode,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      bootstrappedFullCli,
    };
  } finally {
    rmSync(coverageDir, { recursive: true, force: true });
  }
}

test('cli --help returns usage', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agent-device/i);
  assert.match(result.stdout, /agent-device help commands/i);

  const commands = runCli(['help', 'commands']);
  assert.equal(commands.status, 0, commands.stderr);
  assert.match(commands.stdout, /reinstall <app> <path>/i);
});

test('cli --version prints semver and exits 0', () => {
  const result = runCli(['--version']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/i);
});

test('cli -V prints semver and exits 0', () => {
  const result = runCli(['-V']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/i);
});

test('cli without command prints usage and exits 1', () => {
  const result = runCli([]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /agent-device <command>/i);
});

test('known alias registry is non-empty and includes every known alias', () => {
  // Belt-and-braces pin: if the registry were ever emptied by mistake, the two
  // tests below would vacuously pass (an empty `for` loop asserts nothing). Pin
  // both the non-empty condition and the concrete alias set so that failure is
  // loud instead of silent.
  assert.ok(KNOWN_ALIASES.length > 0, 'expected at least one alias to exercise this test');
  const aliasNames = KNOWN_ALIASES.map(([alias]) => alias).sort();
  assert.deepEqual(aliasNames, ['launch', 'long-press', 'relaunch', 'tap'].sort());
});

test('alias --help fast path is byte-identical to its canonical command', () => {
  // The canonical side is always a direct invocation of the canonical command name
  // (never routed through the alias resolver), so this stays an independent oracle:
  // a degenerate resolver that maps every alias to one fixed command would still
  // fail here for the aliases whose canonical command differs.
  for (const [alias, canonical] of KNOWN_ALIASES) {
    const aliasResult = runCli([alias, '--help']);
    const canonicalResult = runCli([canonical, '--help']);
    assert.equal(aliasResult.status, 0, `${alias} --help: ${aliasResult.stderr}`);
    assert.equal(canonicalResult.status, 0, `${canonical} --help: ${canonicalResult.stderr}`);
    assert.equal(
      aliasResult.stdout,
      canonicalResult.stdout,
      `expected "${alias} --help" to be byte-identical to "${canonical} --help"`,
    );
  }
});

test('alias --help fast path bypasses the full CLI bootstrap', () => {
  for (const [alias] of KNOWN_ALIASES) {
    const result = runCliTrackingCoverage([alias, '--help']);
    assert.equal(result.status, 0, `${alias} --help: ${result.stderr}`);
    assert.equal(
      result.bootstrappedFullCli,
      false,
      `expected "${alias} --help" to bypass ${PROCESS_ENTRY_MARKER}`,
    );
  }

  // Control: a retired/unmapped command must still fall through to the full CLI
  // bootstrap, proving the coverage signal actually distinguishes the two paths
  // instead of reading false unconditionally.
  const rotate = runCliTrackingCoverage(['rotate', '--help']);
  assert.equal(rotate.bootstrappedFullCli, true);
});
