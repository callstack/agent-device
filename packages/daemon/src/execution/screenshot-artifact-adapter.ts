import { publishFileSync } from '@agent-device/host-kit/file';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { ArtifactAdapter, ReservedOutputFile } from '@agent-device/contracts/artifact-adapter';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the adapter mints a destination itself: the per-capture default for a capture that
 * names none, a caller-named stable default, and the crop staging root. The
 * session-artifact-paths owner resolves them; a caller that passes nothing keeps the legacy
 * temp-dir lottery.
 */
export type DaemonScreenshotArtifactDefaults = Readonly<{
  /**
   * Directory a capture without an explicit destination mints its own file into, named by
   * `requestNamePrefix` plus a per-capture suffix. Each capture owns its file, so no
   * capture overwrites an earlier one and a failed capture leaves no bytes behind.
   */
  mintDir?: string;
  /** The sanitized request name a minted destination starts with. */
  requestNamePrefix?: string;
  /**
   * Stable destination for this surface's captures without an explicit destination: one
   * shared file, so only callers that own that sharing pass it.
   */
  defaultPath?: string;
  /** Root the crop publish stages into; each request owns the minted dir beneath it. */
  stagingDir?: string;
}>;

export function createDaemonScreenshotArtifactAdapter(
  atomic: boolean,
  signal: AbortSignal | undefined,
  defaults: DaemonScreenshotArtifactDefaults = {},
): ArtifactAdapter {
  return {
    resolveInput: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'screenshot does not resolve input artifacts');
    },
    reserveOutput: async (ref) => {
      let published = false;
      try {
        let tempRoot: string | undefined;
        let outputPath: string;
        if (ref?.kind === 'path') {
          outputPath = ref.path;
        } else if (defaults.mintDir !== undefined) {
          outputPath = await mintCaptureDestination(
            defaults.mintDir,
            defaults.requestNamePrefix ?? 'screenshot',
          );
        } else if (defaults.defaultPath !== undefined) {
          outputPath = defaults.defaultPath;
        } else {
          tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-screenshot-'));
          outputPath = path.join(tempRoot, 'screenshot.png');
        }
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        if (atomic && tempRoot === undefined) {
          return await reserveCroppedOutput(outputPath, signal, defaults.stagingDir);
        }
        return {
          path: outputPath,
          visibility: 'client-visible',
          publish: async () => {
            if (atomic) signal?.throwIfAborted();
            published = true;
            return undefined;
          },
          ...(tempRoot
            ? {
                cleanup: async () => {
                  await fs.rm(tempRoot, { recursive: true, force: true });
                },
              }
            : {}),
          ...(defaults.mintDir !== undefined && tempRoot === undefined
            ? {
                // A minted destination belongs to this request alone: a failed capture
                // removes its own file, and a published one stays as the reported artifact.
                cleanup: async () => {
                  if (published) return;
                  await fs.rm(outputPath, { force: true });
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
  stagingDir: string | undefined,
): Promise<ReservedOutputFile> {
  const destination = await resolveScreenshotDestination(outputPath);
  const stagingParent = stagingDir ?? os.tmpdir();
  await fs.mkdir(stagingParent, { recursive: true });
  // One minted dir per request: concurrent crop publishes stage side by side without
  // a lock, and a cleanup never removes a sibling request's staging dir.
  const stagingRoot = await fs.mkdtemp(path.join(stagingParent, 'agent-device-crop-'));
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

/**
 * Mints one request-scoped capture destination: the request's own name plus a per-capture
 * suffix, so N captures of one request — a remote Maestro flow shares its request id across
 * every step — mint N distinct files instead of resolving to one shared path.
 */
async function mintCaptureDestination(dir: string, prefix: string): Promise<string> {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return path.join(dir, `${prefix}-${suffix}.png`);
}

async function resolveScreenshotDestination(outputPath: string): Promise<string> {
  let destination: string;
  try {
    const entry = await fs.lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    destination = entry?.isSymbolicLink()
      ? await fs.realpath(outputPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            throw new AppError(
              'INVALID_ARGS',
              'Screenshot destination is a dangling symbolic link',
              {
                reason: 'screenshot_destination_dangling_symlink',
                path: outputPath,
              },
            );
          }
          throw error;
        })
      : outputPath;
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
