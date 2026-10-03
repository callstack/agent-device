import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { CommandExecutorOverride } from './exec.ts';

const { mockRunCmdSync } = vi.hoisted(() => ({ mockRunCmdSync: vi.fn() }));

vi.mock('./exec.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec.ts')>()),
  runCmdSync: mockRunCmdSync,
}));

let withCommandExecutorOverride: typeof import('./exec.ts').withCommandExecutorOverride;
let readHostCpuArch: typeof import('./host-process.ts').readHostCpuArch;
let readHostCpuArchSync: typeof import('./host-process.ts').readHostCpuArchSync;
let resolveHostCpuArch: typeof import('./host-process.ts').resolveHostCpuArch;

// The host CPU arch is resolved once per module instance, so each test gets a fresh one.
beforeEach(async () => {
  mockRunCmdSync.mockReset();
  vi.resetModules();
  ({ withCommandExecutorOverride } = await import('./exec.ts'));
  ({ readHostCpuArch, readHostCpuArchSync, resolveHostCpuArch } =
    await import('./host-process.ts'));
});

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

async function asDarwinX64Process(run: () => Promise<void>): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  Object.defineProperty(process, 'arch', { ...arch, value: 'x64' });
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
  }
}

test('the per-process value a Rosetta-translated process resolves is the one sync callers read', async () => {
  await asDarwinX64Process(async () => {
    const sysctl = sysctlAnswering({ stdout: '1\n' });
    const resolved = await withCommandExecutorOverride(sysctl.override, () => readHostCpuArch());
    assert.equal(resolved, 'arm64');
    assert.equal(readHostCpuArchSync(), 'arm64');
    assert.equal(sysctl.calls.length, 1);
    assert.equal(mockRunCmdSync.mock.calls.length, 0);
  });
});

test('a Rosetta-translated process resolves arm64 through the sync path first, and async callers share it', async () => {
  await asDarwinX64Process(async () => {
    mockRunCmdSync.mockReturnValue({ stdout: '1\n', stderr: '', exitCode: 0 });
    assert.equal(readHostCpuArchSync(), 'arm64');
    assert.deepEqual(
      mockRunCmdSync.mock.calls.map(([command, args]) => [command, ...args]),
      [['/usr/sbin/sysctl', '-n', 'hw.optional.arm64']],
    );

    const sysctl = sysctlAnswering({ stdout: '0\n' });
    const resolved = await withCommandExecutorOverride(sysctl.override, () => readHostCpuArch());
    assert.equal(resolved, 'arm64');
    assert.deepEqual(sysctl.calls, []);
  });
});

test('a sync read on an Intel Mac reports x86_64', async () => {
  await asDarwinX64Process(async () => {
    mockRunCmdSync.mockReturnValue({ stdout: '', stderr: '', exitCode: 1 });
    assert.equal(readHostCpuArchSync(), 'x86_64');
  });
});
