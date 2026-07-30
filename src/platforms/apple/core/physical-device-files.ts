import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { Deadline } from '../../../utils/retry.ts';
import { IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS } from './config.ts';
import { IOS_RUNNER_CONTAINER_BUNDLE_IDS } from './runner/runner-cache-metadata.ts';
import { runXcrun } from './tool-provider.ts';

export async function copyCoreDeviceRunnerFile(
  device: DeviceInfo,
  remotePath: string,
  outPath: string,
  timeoutMs = IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  let copyResult = { exitCode: 1, stdout: '', stderr: '' };
  for (const bundleId of IOS_RUNNER_CONTAINER_BUNDLE_IDS) {
    copyResult = await runXcrun(
      [
        'devicectl',
        'device',
        'copy',
        'from',
        '--device',
        device.id,
        '--source',
        remotePath,
        '--destination',
        outPath,
        '--domain-type',
        'appDataContainer',
        '--domain-identifier',
        bundleId,
      ],
      {
        allowFailure: true,
        timeoutMs: resolveCopyTimeoutMs(deadline, timeoutMs),
      },
    );
    if (copyResult.exitCode === 0) return;
  }

  const copyError =
    copyResult.stderr.trim() ||
    copyResult.stdout.trim() ||
    `devicectl exited with code ${copyResult.exitCode}`;
  throw new AppError('COMMAND_FAILED', `Failed to copy runner file from iOS device: ${copyError}`);
}

function resolveCopyTimeoutMs(deadline: Deadline, timeoutMs: number): number {
  const remainingMs = deadline.remainingMs();
  if (remainingMs > 0) return remainingMs;
  throw new AppError('COMMAND_FAILED', `iOS runner file copy timed out after ${timeoutMs}ms`, {
    timeoutMs,
    step: 'runner file copy',
  });
}
