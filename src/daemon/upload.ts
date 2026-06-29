import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { AppError } from '../kernel/errors.ts';
import { extractTarInstallableArtifact } from './artifact-archive.ts';
import {
  createArtifactTempDir,
  sanitizeArtifactFilename,
  streamReadableToFile,
  validateArtifactContentLength,
} from './artifact-download.ts';

export async function receiveUpload(
  req: IncomingMessage,
): Promise<{ artifactPath: string; tempDir: string }> {
  const artifactType = req.headers['x-artifact-type'] as string | undefined;
  const rawFilename = req.headers['x-artifact-filename'] as string | undefined;
  if (!artifactType || !rawFilename) {
    throw new AppError(
      'INVALID_ARGS',
      'Missing required headers: x-artifact-type and x-artifact-filename',
    );
  }
  if (artifactType !== 'file' && artifactType !== 'app-bundle') {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid x-artifact-type: ${artifactType}. Must be "file" or "app-bundle".`,
    );
  }

  validateArtifactContentLength(req.headers['content-length']);
  const artifactFilename = sanitizeArtifactFilename(rawFilename);
  const tempDir = createArtifactTempDir('upload');
  try {
    if (artifactType === 'file') {
      const artifactPath = path.join(tempDir, artifactFilename);
      await streamReadableToFile(req, artifactPath);
      return { artifactPath, tempDir };
    }

    const archivePath = path.join(tempDir, 'artifact.tar');
    await streamReadableToFile(req, archivePath);
    const artifactPath = await extractTarInstallableArtifact({
      archivePath,
      tempDir,
      platform: 'ios',
      expectedRootName: artifactFilename,
    });
    fs.rmSync(archivePath, { force: true });
    return { artifactPath, tempDir };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
