import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { createOwnedFakeCompiler } from './owned-fake-compiler.fixtures.ts';

const execFileAsync = promisify(execFile);
const fixtureTest = test.skipIf(process.platform === 'win32');

fixtureTest('the fake compiler remains pending until its own child is cancelled', async () => {
  const compiler = createOwnedFakeCompiler('fake-compiler-direct-');
  const child = spawn(
    path.join(compiler.toolchainDir, 'xcrun'),
    ['swiftc', 'validator.swift', 'support.swift', '-o', 'validator'],
    { env: { ...process.env, ...compiler.env } },
  );
  const exited = once(child, 'exit');
  try {
    await expect.poll(() => compiler.runningCompilerPids()).toContain(child.pid);
    expect(child.exitCode).toBeNull();
    child.kill('SIGTERM');
    await expect(exited).resolves.toEqual([0, null]);
    expect(compiler.runningCompilerPids()).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
});

fixtureTest.each([
  ['--find', 'swiftc'],
  ['simctl', 'list'],
  ['swiftc', '-typecheck', 'validator.swift'],
])('the fake rejects unrelated xcrun invocation %j', async (...args) => {
  const compiler = createOwnedFakeCompiler('fake-compiler-reject-');
  await expect(
    execFileAsync(path.join(compiler.toolchainDir, 'xcrun'), args, {
      env: { ...process.env, ...compiler.env },
      timeout: 2_000,
    }),
  ).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringContaining('fake xcrun: expected swiftc <source.swift>... -o <output>'),
  });
  expect(compiler.runningCompilerPids()).toEqual([]);
});
