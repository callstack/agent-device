import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createVegaHostStub } from './command-host.fixtures.ts';

test('the command route prefers the CLI the host resolves on its PATH', async () => {
  const stub = createVegaHostStub({ onPath: ['vega'], stdout: 'ok\n' });

  assert.equal(await stub.toolbox.commands.resolveExecutable(), 'vega');
  const result = await stub.toolbox.commands.run(['--version']);

  assert.equal(result.stdout, 'ok\n');
  assert.deepEqual(stub.commands, [
    {
      executable: 'vega',
      args: ['--version'],
      timeoutMs: undefined,
      allowFailure: undefined,
      signal: undefined,
    },
  ]);
});

test('the command route falls back to the host home default install', async () => {
  // The home is the one the host names, never the process's: a resolver that read `os.homedir()`
  // would miss this file and report the CLI missing.
  const stub = createVegaHostStub({
    env: { PATH: '/usr/bin', HOME: '/host-home' },
    onPath: [],
    executableFiles: ['/host-home/vega/bin/vega'],
    stdout: 'Vega CLI 1.3.2\n',
  });

  assert.equal(await stub.toolbox.commands.resolveExecutable(), '/host-home/vega/bin/vega');
  await stub.toolbox.commands.run(['--version']);
  assert.equal(stub.commands[0]?.executable, '/host-home/vega/bin/vega');
});

test('the command route skips the default-install probe when the host names no home', async () => {
  const stub = createVegaHostStub({ env: { PATH: '/usr/bin' }, onPath: [], executableFiles: [] });

  assert.equal(await stub.toolbox.commands.resolveExecutable(), undefined);
});

test('the command route memoizes a found CLI and re-probes a miss', async () => {
  // A CLI installed after a miss is still found on the next call; a CLI once found is not looked up
  // again, so a long-lived daemon does not pay a PATH scan per command.
  const missing = createVegaHostStub({ onPath: [], executableFiles: [] });
  assert.equal(await missing.toolbox.commands.resolveExecutable(), undefined);
  assert.equal(await missing.toolbox.commands.resolveExecutable(), undefined);
  assert.equal(missing.pathProbes(), 2);

  const found = createVegaHostStub({ onPath: ['vega'], stdout: '' });
  await found.toolbox.commands.run(['--version']);
  await found.toolbox.commands.run(['device', 'list']);
  assert.equal(found.pathProbes(), 1);
});

test("the command route hands the host the caller's timeout, failure and cancellation terms", async () => {
  const stub = createVegaHostStub({ stdout: '' });
  const signal = new AbortController().signal;

  await stub.toolbox.commands.run(['device', 'list'], {
    allowFailure: true,
    timeoutMs: 4_000,
    signal,
  });

  assert.deepEqual(stub.commands[0], {
    executable: 'vega',
    args: ['device', 'list'],
    timeoutMs: 4_000,
    allowFailure: true,
    signal,
  });
});

test("the command route keeps the host's answer for the caller to read", async () => {
  const stub = createVegaHostStub({
    respond: () => ({ exitCode: 2, stdout: '', stderr: 'device offline' }),
  });

  const result = await stub.toolbox.commands.run(['device', 'is-connected', '--device', 'vd'], {
    allowFailure: true,
  });

  assert.deepEqual(result, { exitCode: 2, stdout: '', stderr: 'device offline' });
});
