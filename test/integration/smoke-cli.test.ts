import test from 'node:test';
import assert from 'node:assert/strict';
import { runCmdSync } from '../../src/utils/exec.ts';

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = runCmdSync(
    process.execPath,
    ['--experimental-strip-types', 'src/bin.ts', ...args],
    { allowFailure: true },
  );
  return { status: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
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
