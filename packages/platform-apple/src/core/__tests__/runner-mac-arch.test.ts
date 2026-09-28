import assert from 'node:assert/strict';
import { test } from 'vitest';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { readHostCpuArch } from '@agent-device/host-kit/process';
import '../runner-client.ts';
import {
  resolveRunnerBuildDestination,
  resolveRunnerBuildDestinationFamily,
  resolveRunnerDestination,
} from '../../runner/apple-runner-platform.ts';
import { MACOS_DEVICE } from '../../runner/__tests__/device-fixtures.ts';

test('the macOS runner destinations name arm64 when Node runs as x64 under Rosetta', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  Object.defineProperty(process, 'arch', { ...arch, value: 'x64' });
  try {
    await withCommandExecutorOverride(
      async (command, args) => {
        assert.deepEqual([command, ...args], ['/usr/sbin/sysctl', '-n', 'hw.optional.arm64']);
        return { stdout: '1\n', stderr: '', exitCode: 0 };
      },
      () => readHostCpuArch(),
    );
    for (const destination of [
      resolveRunnerDestination(MACOS_DEVICE),
      resolveRunnerBuildDestination(MACOS_DEVICE),
      resolveRunnerBuildDestinationFamily(MACOS_DEVICE),
    ]) {
      assert.equal(destination, 'platform=macOS,arch=arm64');
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'arch', arch);
  }
});
