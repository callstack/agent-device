import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../kernel/errors.ts';
import { runCmd } from '../utils/exec.ts';

const ARTIFACT_HASH_ALGORITHM = 'sha256';
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export type PreparedUploadArtifact = {
  payloadPath: string;
  fileName: string;
  artifactType: 'app-bundle' | 'file';
  platform?: 'ios' | 'android';
  contentType: string;
  sha256: string;
  sizeBytes: number;
  cleanup: () => void;
};

export async function prepareUploadArtifact(
  localPath: string,
  requestedPlatform: string | undefined,
): Promise<PreparedUploadArtifact> {
  const stat = fs.statSync(localPath);
  const fileName = path.basename(localPath);
  const isDirectory = stat.isDirectory();
  const platform =
    normalizeUploadPlatform(requestedPlatform) ?? inferArtifactPlatform(localPath, stat);
  const cleanupPaths: string[] = [];
  try {
    const payloadPath = isDirectory
      ? await createGzipTarArchive(localPath, cleanupPaths)
      : localPath;
    const payloadStat = fs.statSync(payloadPath);

    return {
      payloadPath,
      fileName,
      artifactType: isDirectory ? 'app-bundle' : 'file',
      platform,
      contentType: isDirectory ? 'application/gzip' : DEFAULT_CONTENT_TYPE,
      sha256: await computeFileHash(payloadPath),
      sizeBytes: payloadStat.size,
      cleanup: () => cleanupUploadPaths(cleanupPaths),
    };
  } catch (error) {
    cleanupUploadPaths(cleanupPaths);
    throw error;
  }
}

async function createGzipTarArchive(localPath: string, cleanupPaths: string[]): Promise<string> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-device-upload-${randomUUID()}-`));
  cleanupPaths.push(tempDir);
  const archivePath = path.join(tempDir, `${path.basename(localPath)}.tar.gz`);
  await runCmd(
    'tar',
    ['czf', archivePath, '-C', path.dirname(localPath), path.basename(localPath)],
    {
      env: {
        ...process.env,
        COPYFILE_DISABLE: '1',
      },
    },
  );
  return archivePath;
}

function inferArtifactPlatform(
  localPath: string,
  stat: { isDirectory(): boolean },
): 'ios' | 'android' | undefined {
  const lowered = localPath.toLowerCase();
  if (stat.isDirectory() && lowered.endsWith('.app')) return 'ios';
  if (lowered.endsWith('.ipa')) return 'ios';
  if (lowered.endsWith('.apk') || lowered.endsWith('.aab')) return 'android';
  return undefined;
}

function normalizeUploadPlatform(value: string | undefined): 'ios' | 'android' | undefined {
  return value === 'ios' || value === 'android' ? value : undefined;
}

function cleanupUploadPaths(cleanupPaths: string[]): void {
  for (const cleanupPath of cleanupPaths) {
    fs.rmSync(cleanupPath, { recursive: true, force: true });
  }
}

async function computeFileHash(localPath: string): Promise<string> {
  const hash = createHash(ARTIFACT_HASH_ALGORITHM);
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });
  await pipeline(fs.createReadStream(localPath), sink).catch((err: unknown) => {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to read local artifact',
      {},
      err instanceof Error ? err : undefined,
    );
  });
  return hash.digest('hex');
}
