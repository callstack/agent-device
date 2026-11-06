import { promises as fs } from 'node:fs';
import type { TemporaryFile } from '@agent-device/contracts/artifact-adapter';
import type { ScreenshotDiffEvidence } from '@agent-device/contracts/interaction';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';
import { toBackendContext } from '../../runtime-common.ts';
import { createCommandTempFile } from '../../io-policy.ts';

/**
 * `--expect-screenshot-diff` for press/click: the out-of-tree readback
 * primitive. The screenshots bracket the dispatch, and the comparison runs on
 * pixels, because the surfaces this answers for — a PIN keypad whose keys never
 * reach the accessibility tree, a custom-drawn keyboard — leave `--verify`'s
 * node digest flat no matter what the tap did.
 *
 * Best-effort by the same contract as `--verify` evidence: a capture that fails
 * or a backend without screenshots yields no evidence, which claims nothing
 * about the screen. The comparison never fails the action.
 *
 * The PNG decoder and the pixel ratio load behind function-scoped dynamic
 * imports: an eager edge from every press/click into the decode stack would
 * tax the flag-less fast path, and only the opt-in readback ever decodes a
 * frame (the eager-closure budget).
 */

export type ScreenshotPairOutcome = {
  evidence?: ScreenshotDiffEvidence;
  /** Present when the caller expected a diff and the frames matched. */
  unchangedWarning?: string;
};

/**
 * Runs the dispatch inside the screenshot bracket. Unrequested, this is the
 * dispatch alone. Requested, the before-frame lands after every pre-dispatch
 * guard and immediately before the dispatch, so the pair brackets the tap and
 * nothing else; a dispatch failure cleans the frame up and rethrows, because a
 * failed action owes no post-action comparison.
 */
export async function dispatchWithScreenshotPair<T>(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  requested: boolean,
  dispatch: () => Promise<T>,
): Promise<{ result: T; outcome?: ScreenshotPairOutcome }> {
  const before = requested
    ? await capturePairScreenshotFrame(runtime, options, 'before')
    : undefined;
  let result: T;
  try {
    result = await dispatch();
  } catch (error) {
    if (before) await before.cleanup();
    throw error;
  }
  return {
    result,
    ...(before ? { outcome: await compareScreenshotPair(runtime, options, before) } : {}),
  };
}

/**
 * Folds the pair outcome into the runtime result: the evidence rides as
 * `screenshotDiff`, and the unmet expectation composes its warning after any
 * resolution warning the target already carries, so neither disclosure clobbers
 * the other. The warning is read structurally: only the point/ref/selector
 * variants carry one, and the point variant's is a conditional spread.
 */
export function attachScreenshotPairOutcome<T extends object>(
  result: T,
  outcome: ScreenshotPairOutcome | undefined,
): T {
  if (!outcome) return result;
  const { evidence, unchangedWarning } = outcome;
  return {
    ...result,
    ...(evidence ? { screenshotDiff: evidence } : {}),
    ...(unchangedWarning
      ? { warning: composeWarnings(readResolutionWarning(result), unchangedWarning) }
      : {}),
  };
}

function readResolutionWarning(result: object): string | undefined {
  const warning = (result as { warning?: unknown }).warning;
  return typeof warning === 'string' && warning.length > 0 ? warning : undefined;
}

function composeWarnings(existing: string | undefined, added: string): string {
  return existing ? `${existing} ${added}` : added;
}

/**
 * One frame of the pair. A backend without `captureScreenshot` returns no
 * frame, and the whole readback silently does not run — the flag is advisory,
 * so a screenshot-less platform keeps the dispatch untouched.
 */
async function capturePairScreenshotFrame(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  label: 'before' | 'after',
): Promise<TemporaryFile | undefined> {
  if (!runtime.backend.captureScreenshot) return undefined;
  let frame: TemporaryFile;
  try {
    frame = await createCommandTempFile(runtime, {
      prefix: `agent-device-press-${label}`,
      ext: '.png',
    });
  } catch {
    return undefined;
  }
  try {
    await runtime.backend.captureScreenshot(toBackendContext(runtime, options), frame.path, {
      // The status-bar clock ticks between the frames; normalizing it keeps a
      // minute rollover from reading as the reaction the caller asked about.
      normalizeStatusBar: true,
    });
  } catch {
    await frame.cleanup();
    return undefined;
  }
  return frame;
}

/**
 * Closes the pair: one after-frame, then the pixel comparison. A frame that
 * changed shape (rotation, split-screen) changed the screen by construction —
 * the ratio is omitted because the two frames describe different viewports.
 * Any decode or capture failure drops the evidence rather than guessing.
 */
async function compareScreenshotPair(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  before: TemporaryFile,
): Promise<ScreenshotPairOutcome> {
  try {
    const after = await capturePairScreenshotFrame(runtime, options, 'after');
    if (!after) return {};
    try {
      const [{ computePngChangedPixelRatio }, { decodePng }] = await Promise.all([
        import('@agent-device/capture-kit/png-changed-pixel-ratio'),
        import('@agent-device/capture-kit/png'),
      ]);
      const [beforeBytes, afterBytes] = await Promise.all([
        fs.readFile(before.path),
        fs.readFile(after.path),
      ]);
      const ratio = computePngChangedPixelRatio(
        decodePng(beforeBytes, 'the press before-screenshot'),
        decodePng(afterBytes, 'the press after-screenshot'),
      );
      if (ratio.status === 'dimension_mismatch') {
        return { evidence: { changedFromBefore: true } };
      }
      const evidence: ScreenshotDiffEvidence = {
        changedFromBefore: ratio.changedPixelRatio > 0,
        changedPixelRatio: ratio.changedPixelRatio,
      };
      return {
        evidence,
        ...(evidence.changedFromBefore
          ? {}
          : {
              unchangedWarning:
                'Expected a screen change, but the screenshots taken before and after the dispatch match. The dispatch may have had no visible effect: check the target coordinates against a fresh snapshot.',
            }),
      };
    } finally {
      await after.cleanup();
    }
  } finally {
    await before.cleanup();
  }
}
