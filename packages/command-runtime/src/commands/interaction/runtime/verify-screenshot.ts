import { readFile } from 'node:fs/promises';
import type { TemporaryFile } from '@agent-device/contracts/artifact-adapter';
import type { ScreenshotVerification } from '@agent-device/contracts/interaction';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';
import { createCommandTempFile } from '../../io-policy.ts';
import { sleep } from '../../runtime-common.ts';

export async function withScreenshotVerification<T>(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  dispatch: () => Promise<T>,
): Promise<{ result: T; screenshot?: ScreenshotVerification }> {
  const signal = options.signal ?? runtime.signal;
  const before = await captureFrame(runtime, signal);
  try {
    signal?.throwIfAborted();
    const result = await dispatch();
    if (!before) return { result };
    // Give the tap's first visual update time to reach the display.
    await sleep(runtime, VERIFY_AFTER_FRAME_SETTLE_MS, signal).catch(() => {});
    const after = await captureFrame(runtime, signal);
    if (!after) return { result };
    try {
      const screenshot = await compareFrames(before, after);
      return signal?.aborted ? { result } : { result, screenshot };
    } catch {
      return { result };
    } finally {
      await after.file.cleanup().catch(() => {});
    }
  } finally {
    await before?.file.cleanup().catch(() => {});
  }
}

async function captureFrame(runtime: AgentDeviceRuntime, signal: AbortSignal | undefined) {
  if (signal?.aborted || !runtime.backend.captureVerifyScreenshot) return;
  let file: TemporaryFile | undefined;
  try {
    file = await createCommandTempFile(runtime, { prefix: 'agent-device-verify', ext: '.png' });
    if (!signal?.aborted) {
      const facts = await runtime.backend.captureVerifyScreenshot(file.path);
      if (facts && !signal?.aborted) return { file, ...facts };
    }
  } catch {
    // An unavailable frame leaves tree verification in charge.
  }
  await file?.cleanup().catch(() => {});
}

/** The after frame waits this long past the dispatch reply before it is captured. */
const VERIFY_AFTER_FRAME_SETTLE_MS = 150;

async function compareFrames(
  before: { file: TemporaryFile; ignoreTopHeightShare: number },
  after: { file: TemporaryFile; ignoreTopHeightShare: number },
): Promise<ScreenshotVerification> {
  const [{ computePngChangedPixelRatio }, { decodePngAsync }] = await Promise.all([
    import('@agent-device/capture-kit/png-changed-pixel-ratio'),
    import('@agent-device/capture-kit/png-worker-client'),
  ]);
  const [first, second] = await Promise.all([
    decodePngAsync(await readFile(before.file.path), 'verification before frame'),
    decodePngAsync(await readFile(after.file.path), 'verification after frame'),
  ]);
  const comparison = computePngChangedPixelRatio(first, second, {
    ignoreTopHeightShare:
      first.height >= first.width
        ? Math.min(before.ignoreTopHeightShare, after.ignoreTopHeightShare)
        : 0,
  });
  return comparison.status === 'dimension_mismatch'
    ? { changedFromBefore: true }
    : {
        changedFromBefore: comparison.changedPixelRatio > 0,
        changedPixelRatio: comparison.changedPixelRatio,
      };
}
