import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../kernel/errors.ts';
import { runCmd } from '../utils/exec.ts';
import {
  expiredTenantOwnedEntryError,
  requireTenantOwnedEntry,
  type TenantOwnedResourceKind,
} from './tenant-owned-entry.ts';

// --- Downloadable artifact tracking ---

const ARTIFACT_CLEANUP_TIMEOUT_MS = 15 * 60 * 1000;

const DOWNLOADABLE_ARTIFACT_RESOURCE: TenantOwnedResourceKind = {
  label: 'Artifact',
  expiredHint: `Downloadable artifacts are removed after download or after ${ARTIFACT_CLEANUP_TIMEOUT_MS / 60_000} minutes. Re-run the command that produced the artifact and download it again.`,
};
const DEFAULT_DOWNLOAD_MIME_TYPE = 'application/octet-stream';
const DIRECTORY_ARCHIVE_MIME_TYPE = 'application/gzip';

type DirectoryArchive = {
  archivePath: string;
  tempDir: string;
  fileName: string;
  sizeBytes: number;
};

type ArtifactEntry = {
  artifactPath: string;
  tenantId?: string;
  fileName?: string;
  deleteAfterDownload: boolean;
  createdAt: number;
  directoryArchive?: DirectoryArchive;
  directoryArchivePromise?: Promise<DirectoryArchive>;
  timer: ReturnType<typeof setTimeout>;
};

const pendingArtifacts = new Map<string, ArtifactEntry>();

export type DownloadableArtifactInventoryEntry = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
};

export type PreparedDownloadableArtifact = {
  artifactPath: string;
  fileName?: string;
  mimeType: string;
  sizeBytes: number;
};

export function trackDownloadableArtifact(params: {
  artifactPath: string;
  tenantId?: string;
  fileName?: string;
  deleteAfterDownload?: boolean;
}): string {
  const artifactId = crypto.randomUUID();
  const createdAt = Date.now();
  const timer = setTimeout(() => {
    cleanupDownloadableArtifact(artifactId);
  }, ARTIFACT_CLEANUP_TIMEOUT_MS);
  timer.unref();
  pendingArtifacts.set(artifactId, {
    artifactPath: params.artifactPath,
    tenantId: params.tenantId,
    fileName: params.fileName,
    deleteAfterDownload: params.deleteAfterDownload !== false,
    createdAt,
    timer,
  });
  return artifactId;
}

export async function prepareDownloadableArtifact(
  artifactId: string,
  tenantId?: string,
): Promise<PreparedDownloadableArtifact> {
  const { entry, stat } = readDownloadableArtifactEntry(artifactId, tenantId);
  const payload = await prepareArtifactPayload(artifactId, entry, stat);
  if (!payload) {
    throw new AppError(
      'COMMAND_FAILED',
      `Artifact path is not a regular file or directory: ${entry.artifactPath}`,
    );
  }
  return payload;
}

export async function listDownloadableArtifacts(
  tenantId?: string,
): Promise<DownloadableArtifactInventoryEntry[]> {
  const artifacts: DownloadableArtifactInventoryEntry[] = [];
  for (const [id, entry] of pendingArtifacts) {
    if (!canReadArtifact(entry, tenantId)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entry.artifactPath);
    } catch {
      cleanupDownloadableArtifact(id);
      continue;
    }
    const payload = await prepareArtifactPayloadForInventory(id, entry, stat);
    if (!payload) continue;
    artifacts.push({
      id,
      filename: payload.fileName ?? id,
      mimeType: payload.mimeType,
      sizeBytes: payload.sizeBytes,
      createdAt: new Date(entry.createdAt).toISOString(),
      expiresAt: new Date(entry.createdAt + ARTIFACT_CLEANUP_TIMEOUT_MS).toISOString(),
    });
  }
  return artifacts;
}

async function prepareArtifactPayloadForInventory(
  artifactId: string,
  entry: ArtifactEntry,
  stat: fs.Stats,
): Promise<PreparedDownloadableArtifact | null> {
  try {
    return await prepareArtifactPayload(artifactId, entry, stat);
  } catch {
    // Inventory is best-effort; direct downloads still surface artifact-specific errors.
    return null;
  }
}

function readDownloadableArtifactEntry(
  artifactId: string,
  tenantId: string | undefined,
): { entry: ArtifactEntry; stat: fs.Stats } {
  const entry = requireTenantOwnedEntry(
    pendingArtifacts,
    artifactId,
    tenantId,
    DOWNLOADABLE_ARTIFACT_RESOURCE,
  );
  let stat: fs.Stats;
  try {
    stat = fs.statSync(entry.artifactPath);
  } catch {
    cleanupDownloadableArtifact(artifactId);
    throw new AppError('COMMAND_FAILED', `Artifact file is missing: ${entry.artifactPath}`);
  }
  return { entry, stat };
}

async function prepareArtifactPayload(
  artifactId: string,
  entry: ArtifactEntry,
  stat: fs.Stats,
): Promise<PreparedDownloadableArtifact | null> {
  if (stat.isFile()) {
    return {
      artifactPath: entry.artifactPath,
      fileName: safeArtifactFilename(entry.fileName, artifactId),
      mimeType: DEFAULT_DOWNLOAD_MIME_TYPE,
      sizeBytes: stat.size,
    };
  }
  if (!stat.isDirectory()) return null;

  const directoryArchive = await ensureDirectoryArchive(artifactId, entry);
  return {
    artifactPath: directoryArchive.archivePath,
    fileName: directoryArchive.fileName,
    mimeType: DIRECTORY_ARCHIVE_MIME_TYPE,
    sizeBytes: directoryArchive.sizeBytes,
  };
}

async function ensureDirectoryArchive(
  artifactId: string,
  entry: ArtifactEntry,
): Promise<DirectoryArchive> {
  if (entry.directoryArchive && fs.existsSync(entry.directoryArchive.archivePath)) {
    return entry.directoryArchive;
  }
  if (entry.directoryArchivePromise) {
    return await entry.directoryArchivePromise;
  }

  const archivePromise = createDirectoryArchive(artifactId, entry);
  entry.directoryArchivePromise = archivePromise;
  try {
    return await archivePromise;
  } finally {
    if (entry.directoryArchivePromise === archivePromise) {
      entry.directoryArchivePromise = undefined;
    }
  }
}

async function createDirectoryArchive(
  artifactId: string,
  entry: ArtifactEntry,
): Promise<DirectoryArchive> {
  cleanupDirectoryArchive(entry);

  const sourceName = safeArtifactFilename(
    entry.fileName,
    path.basename(entry.artifactPath) || artifactId,
  );
  const fileName = archiveFilename(sourceName);
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `agent-device-download-${crypto.randomUUID()}-`),
  );
  const archivePath = path.join(tempDir, fileName);
  try {
    await runCmd(
      'tar',
      [
        'czf',
        archivePath,
        '-C',
        path.dirname(entry.artifactPath),
        '--',
        path.basename(entry.artifactPath),
      ],
      {
        env: {
          ...process.env,
          COPYFILE_DISABLE: '1',
        },
      },
    );
    const archive = {
      archivePath,
      tempDir,
      fileName,
      sizeBytes: fs.statSync(archivePath).size,
    };
    // The artifact may be consumed or expire while tar is still archiving.
    if (pendingArtifacts.get(artifactId) !== entry) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw expiredTenantOwnedEntryError(DOWNLOADABLE_ARTIFACT_RESOURCE, artifactId);
    }
    entry.directoryArchive = archive;
    return archive;
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (error instanceof AppError) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to archive downloadable artifact: ${entry.artifactPath}`,
      { artifactPath: entry.artifactPath },
      error instanceof Error ? error : undefined,
    );
  }
}

function archiveFilename(fileName: string): string {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.tar.gz') || lowered.endsWith('.tgz')) return fileName;
  return `${fileName}.tar.gz`;
}

function canReadArtifact(entry: ArtifactEntry, tenantId: string | undefined): boolean {
  if (!entry.tenantId) return true;
  return entry.tenantId === tenantId;
}

function safeArtifactFilename(fileName: string | undefined, fallback: string): string {
  const cleaned = fileName?.trim();
  return cleaned && !hasUnsafeFilenameCharacter(cleaned) ? cleaned : fallback;
}

function hasUnsafeFilenameCharacter(fileName: string): boolean {
  return (
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    fileName.includes('\r') ||
    fileName.includes('\n')
  );
}

export function cleanupDownloadableArtifact(artifactId: string): void {
  const entry = pendingArtifacts.get(artifactId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingArtifacts.delete(artifactId);
  cleanupDirectoryArchive(entry);
  if (!entry.deleteAfterDownload) return;
  try {
    fs.rmSync(entry.artifactPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

function cleanupDirectoryArchive(entry: ArtifactEntry): void {
  if (!entry.directoryArchive) return;
  try {
    fs.rmSync(entry.directoryArchive.tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  } finally {
    entry.directoryArchive = undefined;
  }
}

// --- Upload artifact tracking ---

const UPLOAD_CLEANUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const UPLOADED_ARTIFACT_RESOURCE: TenantOwnedResourceKind = {
  label: 'Uploaded artifact',
  expiredHint: `Uploaded artifacts expire ${UPLOAD_CLEANUP_TIMEOUT_MS / 60_000} minutes after upload. Upload the file again and retry with the new upload id.`,
};

type UploadEntry = {
  artifactPath: string;
  tempDir: string;
  tenantId?: string;
  timer: ReturnType<typeof setTimeout>;
};

const pendingUploads = new Map<string, UploadEntry>();

export function trackUploadedArtifact(params: {
  artifactPath: string;
  tempDir: string;
  tenantId?: string;
}): string {
  const uploadId = crypto.randomUUID();
  const timer = setTimeout(() => {
    cleanupUploadedArtifact(uploadId);
  }, UPLOAD_CLEANUP_TIMEOUT_MS);
  timer.unref();
  pendingUploads.set(uploadId, {
    artifactPath: params.artifactPath,
    tempDir: params.tempDir,
    tenantId: params.tenantId,
    timer,
  });
  return uploadId;
}

export function prepareUploadedArtifact(uploadId: string, tenantId?: string): string {
  const entry = requireTenantOwnedEntry(
    pendingUploads,
    uploadId,
    tenantId,
    UPLOADED_ARTIFACT_RESOURCE,
  );
  clearTimeout(entry.timer);
  return entry.artifactPath;
}

export function cleanupUploadedArtifact(uploadId: string): void {
  const entry = pendingUploads.get(uploadId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingUploads.delete(uploadId);
  fs.rmSync(entry.tempDir, { recursive: true, force: true });
}
