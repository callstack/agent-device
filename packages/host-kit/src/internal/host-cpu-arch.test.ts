import assert from 'node:assert/strict';
import { test } from 'vitest';
import { type CommandExecutorOverride, withCommandExecutorOverride } from './exec.ts';
import { resolveHostCpuArch } from './host-cpu-arch.ts';

function sysctlAnswering(result: { stdout?: string; exitCode?: number } | Error) {
  const calls: string[][] = [];
  const override: CommandExecutorOverride = async (command, args) => {
    calls.push([command, ...args]);
    if (result instanceof Error) throw result;
    return { stdout: result.stdout ?? '', stderr: '', exitCode: result.exitCode ?? 0 };
  };
  return { calls, override };
}

test('an Apple silicon Mac reports arm64 even when Node runs as x64 under Rosetta', async () => {
  const sysctl = sysctlAnswering({ stdout: '1\n' });
  const arch = await withCommandExecutorOverride(sysctl.override, () =>
    resolveHostCpuArch('darwin', 'x64'),
  );
  assert.equal(arch, 'arm64');
  assert.deepEqual(sysctl.calls, [['/usr/sbin/sysctl', '-n', 'hw.optional.arm64']]);
});

test('a Mac without the arm64 sysctl key falls back to the Node arch in Apple naming', async () => {
  for (const answer of [
    { stdout: '', exitCode: 1 },
    { stdout: '0\n' },
    new Error('spawn /usr/sbin/sysctl ENOENT'),
  ]) {
    const sysctl = sysctlAnswering(answer);
    const arch = await withCommandExecutorOverride(sysctl.override, () =>
      resolveHostCpuArch('darwin', 'x64'),
    );
    assert.equal(arch, 'x86_64');
  }
});

test('other platforms report the Node arch without running sysctl', async () => {
  const sysctl = sysctlAnswering({ stdout: '1\n' });
  await withCommandExecutorOverride(sysctl.override, async () => {
    assert.equal(await resolveHostCpuArch('linux', 'x64'), 'x86_64');
    assert.equal(await resolveHostCpuArch('linux', 'arm64'), 'arm64');
    assert.equal(await resolveHostCpuArch('linux', 'ppc64'), 'ppc64');
  });
  assert.deepEqual(sysctl.calls, []);
});
