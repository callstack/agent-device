import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type {
  ArtifactAdapter,
  LocalArtifactAdapterOptions,
} from '@agent-device/contracts/artifact-adapter';

export function createLocalArtifactAdapter(
  options: LocalArtifactAdapterOptions = {},
): ArtifactAdapter {
  const cwd = options.cwd ?? process.cwd();
  const tempDir = options.tempDir ?? os.tmpdir();
  const rootDir = options.rootDir ? resolveLocalPath(options.rootDir, cwd) : undefined;

  return {
    resolveInput: async (ref) => {
      if (ref.kind === 'uploadedArtifact') {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Uploaded artifact inputs require a custom artifact adapter',
        );
      }
      return { path: resolveLocalPath(ref.path, cwd, rootDir) };
    },
    reserveOutput: async (ref, outputOptions) => {
      let tempRoot: string | undefined;
      const visibility = outputOptions.visibility ?? 'client-visible';
      const outputPath =
        ref?.kind === 'path'
          ? resolveLocalPath(ref.path, cwd, rootDir)
          : path.join(
              (tempRoot = await fs.mkdtemp(
                path.join(tempDir, `agent-device-${outputOptions.field}-`),
              )),
              `${outputOptions.field}${outputOptions.ext}`,
            );
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      return {
        path: outputPath,
        visibility,
        ...(tempRoot
          ? {
              cleanup: async () => {
                await fs.rm(tempRoot, { recursive: true, force: true });
              },
            }
          : {}),
        publish: async () =>
          ref?.kind === 'downloadableArtifact'
            ? {
                kind: 'localPath',
                field: outputOptions.field,
                artifactType: outputOptions.artifactType,
                path: outputPath,
                fileName: ref.fileName ?? path.basename(ref.clientPath ?? outputPath),
              }
            : undefined,
      };
    },
    createTempFile: async (tempOptions) => {
      const root = await fs.mkdtemp(path.join(tempDir, `${tempOptions.prefix}-`));
      return {
        path: path.join(root, `file${tempOptions.ext}`),
        visibility: 'internal',
        cleanup: async () => {
          await fs.rm(root, { recursive: true, force: true });
        },
      };
    },
  };
}

function resolveLocalPath(filePath: string, cwd: string, rootDir?: string): string {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  if (rootDir && !isPathInside(resolvedPath, rootDir)) {
    throw new AppError('INVALID_ARGS', 'Local path is outside the artifact adapter root', {
      path: resolvedPath,
      rootDir,
    });
  }
  return resolvedPath;
}

function isPathInside(filePath: string, rootDir: string): boolean {
  const relative = path.relative(rootDir, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
