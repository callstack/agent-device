import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';

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

test('alias --help fast path is byte-identical to its canonical command', () => {
  const tap = runCli(['tap', '--help']);
  const press = runCli(['press', '--help']);
  assert.equal(tap.status, 0, tap.stderr);
  assert.equal(press.status, 0, press.stderr);
  assert.equal(tap.stdout, press.stdout);

  const launch = runCli(['launch', '--help']);
  const open = runCli(['open', '--help']);
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(open.status, 0, open.stderr);
  assert.equal(launch.stdout, open.stdout);
});

test('alias --help fast path bypasses the full CLI bootstrap', () => {
  const tap = runCliTrackingCoverage(['tap', '--help']);
  assert.equal(tap.status, 0, tap.stderr);
  assert.equal(tap.bootstrappedFullCli, false);

  const launch = runCliTrackingCoverage(['launch', '--help']);
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(launch.bootstrappedFullCli, false);

  // Control: a retired/unmapped command must still fall through to the full CLI
  // bootstrap, proving the coverage signal actually distinguishes the two paths
  // instead of reading false unconditionally.
  const rotate = runCliTrackingCoverage(['rotate', '--help']);
  assert.equal(rotate.bootstrappedFullCli, true);
});
