import path from 'node:path';
import type { FoldKeyframe, FoldPose } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';
import { makeHostTemporaryDirectory, removeHostDirectory } from '@agent-device/host-kit/host-file';
import { findProjectRoot } from '@agent-device/host-kit/version';
import { runXcrun } from '../core/tool-provider.ts';

/** Compiles for the selected Xcode and dispatches inside exactly the requested simulator. */
export async function sendSimulatorFoldPose(
  udid: string,
  pose: FoldPose | readonly FoldKeyframe[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const directory = await makeHostTemporaryDirectory('agent-device-fold-');
  try {
    const binary = path.join(directory, 'fold');
    const build = await runXcrun(
      [
        '--sdk',
        'iphonesimulator',
        'clang',
        '-mios-simulator-version-min=15.0',
        '-fobjc-arc',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-framework',
        'Foundation',
        '-framework',
        'IOKit',
        path.join(findProjectRoot(), 'apple', 'fold-helper', 'Fold.m'),
        '-o',
        binary,
      ],
      { signal, timeoutMs: 30_000, allowFailure: true },
    );
    if (build.exitCode !== 0) {
      throw new AppError(
        'COMMAND_FAILED',
        'Unable to build the simulator fold helper',
        execFailureDetails(build, {
          reason: 'fold-helper-build-failed',
          hint: 'Select an Xcode with the iOS simulator SDK and foldable HID support using DEVELOPER_DIR.',
        }),
      );
    }
    signal?.throwIfAborted();
    const durationMs = typeof pose === 'string' ? 0 : pose.at(-1)!.atMs;
    const payload = typeof pose === 'string' ? pose : JSON.stringify(pose);
    const sent = await runXcrun(['simctl', 'spawn', udid, binary, payload], {
      signal,
      timeoutMs: durationMs + 10_000,
      // simctl must forward termination to the guest before the host kills it.
      kill: { signal: 'SIGTERM', graceMs: 1000 },
      allowFailure: true,
    });
    if (sent.exitCode !== 0) {
      throw new AppError(
        'COMMAND_FAILED',
        'Unable to send the simulator hinge pose',
        execFailureDetails(sent, { reason: 'fold-hid-dispatch-failed', deviceId: udid }),
      );
    }
  } finally {
    await removeHostDirectory(directory);
  }
}
