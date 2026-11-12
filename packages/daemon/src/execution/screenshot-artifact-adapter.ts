import { publishFileSync } from '@agent-device/host-kit/file';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { ArtifactAdapter, ReservedOutputFile } from '@agent-device/contracts/artifact-adapter';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createDaemonScreenshotArtifactAdapter(
  atomic: boolean,
  signal: AbortSignal | undefined,
): ArtifactAdapter {
  return {
    resolveInput: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'screenshot does not resolve input artifacts');
    },
    reserveOutput: async (ref) => {
      try {
        let tempRoot: string | undefined;
        let outputPath: string;
        if (ref?.kind === 'path') {
          outputPath = ref.path;
        } else {
          tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-screenshot-'));
          outputPath = path.join(tempRoot, 'screenshot.png');
        }
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        if (atomic && ref?.kind === 'path') {
          return await reserveCroppedOutput(outputPath, signal);
        }
        return {
          path: outputPath,
          visibility: 'client-visible',
          publish: async () => undefined,
          ...(tempRoot
            ? {
                cleanup: async () => {
                  await fs.rm(tempRoot, { recursive: true, force: true });
                },
              }
            : {}),
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw screenshotPublicationError(
          error,
          ref?.kind === 'path' ? ref.path : '(temporary screenshot)',
        );
      }
    },
    createTempFile: async (options) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `${options.prefix}-`));
      return {
        path: path.join(root, `file${options.ext}`),
        visibility: 'internal',
        cleanup: async () => {
          await fs.rm(root, { recursive: true, force: true });
        },
      };
    },
  };
}

function screenshotPublicationError(error: unknown, outputPath: string): AppError {
  return new AppError('COMMAND_FAILED', 'Failed to publish screenshot', {
    reason: 'screenshot_publication_failed',
    path: outputPath,
    ...(error instanceof Error && 'code' in error ? { filesystemCode: error.code } : {}),
    cause: errorMessage(error),
  });
}

async function reserveCroppedOutput(
  outputPath: string,
  signal: AbortSignal | undefined,
): Promise<ReservedOutputFile> {
  const destination = await resolveScreenshotDestination(outputPath);
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-crop-'));
  const stagingPath = path.join(stagingRoot, `screenshot${path.extname(outputPath) || '.png'}`);
  const cleanup = async () => {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch((error: unknown) => {
      emitDiagnostic({
        level: 'warn',
        phase: 'screenshot_crop_cleanup_failed',
        data: { tempRoot: stagingRoot, error: errorMessage(error) },
      });
    });
  };
  return {
    path: stagingPath,
    publishedPath: outputPath,
    visibility: 'client-visible',
    publish: async () => {
      try {
        const contents = await fs.readFile(stagingPath);
        signal?.throwIfAborted();
        publishFileSync({ destination, contents, preserveExistingMode: true });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw screenshotPublicationError(error, outputPath);
      }
      await cleanup();
      return undefined;
    },
    cleanup,
  };
}

async function resolveScreenshotDestination(outputPath: string): Promise<string> {
  let destination: string;
  try {
    const entry = await fs.lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    destination = entry?.isSymbolicLink() ? await fs.realpath(outputPath) : outputPath;
    const target = await fs.stat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (target && !target.isFile()) {
      throw new AppError('INVALID_ARGS', 'Screenshot destination must be a regular file', {
        reason: 'screenshot_destination_not_file',
        path: outputPath,
      });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw screenshotPublicationError(error, outputPath);
  }

  return destination;
}
