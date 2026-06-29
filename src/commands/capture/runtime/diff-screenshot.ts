import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BackendScreenshotOptions, BackendScreenshotResult } from '../../../backend.ts';
import type {
  ArtifactDescriptor,
  FileInputRef,
  FileOutputRef,
  ReservedOutputFile,
  ResolvedInputFile,
} from '../../../io.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { AppError } from '../../../kernel/errors.ts';
import {
  compareScreenshots,
  type ScreenshotDiffResult,
} from '../../../screenshot-diff/screenshot-diff.ts';
import { attachCurrentOverlayMatches } from '../../../screenshot-diff/screenshot-diff-overlay-matches.ts';
import type { RuntimeCommand } from '../../runtime-types.ts';
import {
  createCommandTempFile,
  reserveCommandOutput,
  resolveCommandInput,
} from '../../io-policy.ts';

export type LiveScreenshotInputRef = {
  kind: 'live';
};

export type DiffScreenshotCommandOptions = CommandContext & {
  baseline: FileInputRef;
  current?: FileInputRef | LiveScreenshotInputRef;
  out?: FileOutputRef;
  currentOverlayOut?: FileOutputRef;
  threshold?: number;
  overlayRefs?: boolean;
  normalizeStatusBar?: boolean;
  surface?: BackendScreenshotOptions['surface'];
};

export type DiffScreenshotCommandResult = ScreenshotDiffResult & {
  artifacts?: ArtifactDescriptor[];
};

const DEFAULT_SCREENSHOT_DIFF_THRESHOLD = 0.1;

export const diffScreenshotCommand: RuntimeCommand<
  DiffScreenshotCommandOptions,
  DiffScreenshotCommandResult
> = async (runtime, options): Promise<DiffScreenshotCommandResult> => {
  if (!options.baseline) {
    throw new AppError('INVALID_ARGS', 'diff screenshot requires a baseline image');
  }

  const threshold = normalizeThreshold(options.threshold);
  const currentRef = options.current ?? { kind: 'live' };
  if (options.overlayRefs && !isLiveCurrentRef(currentRef)) {
    throw new AppError(
      'INVALID_ARGS',
      'diff screenshot <current.png> cannot use --overlay-refs because saved-image comparisons have no live accessibility refs',
    );
  }

  const baseline = await resolveCommandInput(runtime, options.baseline, {
    usage: 'diff screenshot baseline',
    field: 'baseline',
  });
  let current: ResolvedInputFile | undefined;
  let liveCurrent: ResolvedInputFile | undefined;
  let output: ReservedOutputFile | undefined;
  const artifacts: ArtifactDescriptor[] = [];

  try {
    let currentPath: string;
    if (isLiveCurrentRef(currentRef)) {
      liveCurrent = await captureLiveCurrentScreenshot(runtime, options);
      currentPath = liveCurrent.path;
    } else {
      current = await resolveCommandInput(runtime, currentRef, {
        usage: 'diff screenshot current',
        field: 'current',
      });
      currentPath = current.path;
    }

    output = options.out
      ? await reserveCommandOutput(runtime, options.out, {
          field: 'diffPath',
          ext: '.png',
        })
      : undefined;

    let result: ScreenshotDiffResult = await compareScreenshots(baseline.path, currentPath, {
      threshold,
      outputPath: output?.path,
      maxPixels: runtime.policy.maxImagePixels,
    });

    if (isLiveCurrentRef(currentRef)) {
      result = await maybeAttachCurrentOverlay(runtime, options, output?.path, result, artifacts);
    }

    const diffArtifact = result.diffPath ? await output?.publish() : undefined;
    if (diffArtifact) artifacts.push(diffArtifact);
    if (!result.diffPath) await output?.cleanup?.();

    return {
      ...result,
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  } catch (error) {
    await output?.cleanup?.();
    throw error;
  } finally {
    await baseline.cleanup?.();
    await current?.cleanup?.();
    await liveCurrent?.cleanup?.();
  }
};

function normalizeThreshold(threshold: unknown): number {
  if (threshold == null || threshold === '') return DEFAULT_SCREENSHOT_DIFF_THRESHOLD;
  const value = Number(threshold);
  if (Number.isNaN(value) || value < 0 || value > 1) {
    throw new AppError('INVALID_ARGS', '--threshold must be a number between 0 and 1');
  }
  return value;
}

async function captureLiveCurrentScreenshot(
  runtime: AgentDeviceRuntime,
  options: DiffScreenshotCommandOptions,
): Promise<ResolvedInputFile> {
  const temp = await createCommandTempFile(runtime, {
    prefix: 'agent-device-diff-current',
    ext: '.png',
  });
  try {
    await captureScreenshot(runtime, options, temp.path, liveDiffScreenshotOptions(options));
  } catch (error) {
    await temp.cleanup();
    throw error;
  }
  return temp;
}

// fallow-ignore-next-line complexity
async function maybeAttachCurrentOverlay(
  runtime: AgentDeviceRuntime,
  options: DiffScreenshotCommandOptions,
  diffOutputPath: string | undefined,
  result: ScreenshotDiffResult,
  artifacts: ArtifactDescriptor[],
): Promise<ScreenshotDiffResult> {
  if (!options.overlayRefs) return result;
  if (result.match || result.dimensionMismatch) {
    if (diffOutputPath) await removeStaleCurrentOverlay(diffOutputPath);
    return result;
  }

  const overlayOutputRef = resolveCurrentOverlayOutputRef(options, diffOutputPath);
  const overlayOutput = await reserveCommandOutput(runtime, overlayOutputRef, {
    field: 'currentOverlayPath',
    ext: '.png',
  });

  try {
    const overlayResult = await captureScreenshot(runtime, options, overlayOutput.path, {
      overlayRefs: true,
      ...liveDiffScreenshotOptions(options),
    });
    const overlayArtifact = await overlayOutput.publish();
    if (overlayArtifact) artifacts.push(overlayArtifact);

    return {
      ...result,
      currentOverlayPath: overlayResult.path ?? overlayOutput.path,
      ...(overlayResult.overlayRefs
        ? { currentOverlayRefCount: overlayResult.overlayRefs.length }
        : {}),
      ...(result.regions && overlayResult.overlayRefs
        ? {
            regions: attachCurrentOverlayMatches(result.regions, overlayResult.overlayRefs),
          }
        : {}),
    };
  } catch (error) {
    await overlayOutput.cleanup?.();
    throw error;
  }
}

async function captureScreenshot(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  outPath: string,
  screenshotOptions: BackendScreenshotOptions = {},
): Promise<BackendScreenshotResult> {
  if (!runtime.backend.captureScreenshot) {
    throw new AppError('UNSUPPORTED_OPERATION', 'screenshot is not supported by this backend');
  }
  return (
    (await runtime.backend.captureScreenshot(
      {
        session: options.session,
        requestId: options.requestId,
        signal: options.signal ?? runtime.signal,
        metadata: options.metadata,
      },
      outPath,
      screenshotOptions,
    )) ?? {}
  );
}

function liveDiffScreenshotOptions(
  options: Pick<DiffScreenshotCommandOptions, 'normalizeStatusBar' | 'surface'>,
): BackendScreenshotOptions {
  return {
    normalizeStatusBar: options.normalizeStatusBar ?? true,
    ...(options.surface ? { surface: options.surface } : {}),
  };
}

function resolveCurrentOverlayOutputRef(
  options: DiffScreenshotCommandOptions,
  diffOutputPath: string | undefined,
): FileOutputRef | undefined {
  if (options.currentOverlayOut) return options.currentOverlayOut;
  if (options.out?.kind === 'path') {
    return {
      kind: 'path',
      path: deriveCurrentOverlayPath(diffOutputPath ?? options.out.path),
    };
  }
  if (options.out?.kind === 'downloadableArtifact') {
    return {
      kind: 'downloadableArtifact',
      ...(options.out.clientPath
        ? { clientPath: deriveCurrentOverlayPath(options.out.clientPath) }
        : {}),
      ...(options.out.fileName ? { fileName: deriveCurrentOverlayPath(options.out.fileName) } : {}),
    };
  }
  return undefined;
}

function deriveCurrentOverlayPath(outputPath: string): string {
  const extension = path.extname(outputPath);
  const base = extension ? outputPath.slice(0, -extension.length) : outputPath;
  return `${base}.current-overlay${extension || '.png'}`;
}

async function removeStaleCurrentOverlay(outputPath: string): Promise<void> {
  try {
    await fs.unlink(deriveCurrentOverlayPath(outputPath));
  } catch (error) {
    if (!isFsError(error, 'ENOENT')) throw error;
  }
}

function isLiveCurrentRef(
  inputRef: FileInputRef | LiveScreenshotInputRef,
): inputRef is LiveScreenshotInputRef {
  return inputRef.kind === 'live';
}

function isFsError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
