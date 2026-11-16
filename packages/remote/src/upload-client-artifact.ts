import type { EnvMap } from '@agent-device/kernel/source-value';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@agent-device/kernel/errors';
import type { PackedGzipTar } from '@agent-device/host-kit/gzip-tar';

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
  env: Readonly<EnvMap>,
  signal?: AbortSignal,
): Promise<PreparedUploadArtifact> {
  signal?.throwIfAborted();
  const stat = fs.statSync(localPath);
  const fileName = path.basename(localPath);
  const isDirectory = stat.isDirectory();
  const platform =
    normalizeUploadPlatform(requestedPlatform) ?? inferArtifactPlatform(localPath, stat);
  let packed: PackedGzipTar | undefined;
  try {
    if (isDirectory) {
      // Loaded on demand: only a directory upload packs, and the CLI's eager closure stays small.
      const { packGzipTar } = await import('@agent-device/host-kit/gzip-tar');
      packed = await packGzipTar(localPath, signal ? { env, signal } : { env });
    }
    const payloadPath = packed?.archivePath ?? localPath;
    signal?.throwIfAborted();
    const payloadStat = fs.statSync(payloadPath);

    return {
      payloadPath,
      fileName,
      artifactType: isDirectory ? 'app-bundle' : 'file',
      platform,
      contentType: isDirectory ? 'application/gzip' : DEFAULT_CONTENT_TYPE,
      sha256: await computeFileHash(payloadPath, signal),
      sizeBytes: payloadStat.size,
      cleanup: () => packed?.cleanup(),
    };
  } catch (error) {
    packed?.cleanup();
    throw error;
  }
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

async function computeFileHash(localPath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash(ARTIFACT_HASH_ALGORITHM);
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });
  await pipeline(fs.createReadStream(localPath), sink, { signal }).catch((error: unknown) => {
    signal?.throwIfAborted();
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to read local artifact',
      {},
      error instanceof Error ? error : undefined,
    );
  });
  return hash.digest('hex');
}
