import { runtimeSlot } from '@agent-device/host-kit/runtime-slots';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import type { DaemonArtifactType } from '@agent-device/kernel/contracts';
import type { DeviceRotation } from '@agent-device/contracts/device';
import type { DaemonArtifactInventoryEntry } from '@agent-device/contracts/observability';
import { runCmd } from '@agent-device/host-kit/command';
import {
  expiredTenantOwnedEntryError,
  requireTenantOwnedEntry,
  type TenantOwnedResourceKind,
} from '../core/tenant-owned-entry.ts';

// --- Downloadable artifact tracking ---

const ARTIFACT_CLEANUP_TIMEOUT_MS = 15 * 60 * 1000;
const ARTIFACT_DOWNLOAD_MAX_LIFETIME_MS = 15 * 60 * 1000;

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

type DirectoryArchiveBuild = {
  promise: Promise<DirectoryArchive>;
  controller: AbortController;
};

type ArtifactSourceCleanup = {
  remainingEntries: number;
  deleteAfterDownload: boolean;
};

type ArtifactDownload = {
  controller: AbortController;
  stream?: fs.ReadStream;
  release: () => void;
};

type ArtifactEntry = {
  artifactPath: string;
  tenantId?: string;
  artifactType: DaemonArtifactType | undefined;
  fileName?: string;
  displayRotation?: DeviceRotation;
  sessionName?: string;
  sourceCleanup: ArtifactSourceCleanup;
  createdAt: number;
  directoryArchive?: DirectoryArchive;
  directoryArchiveBuild?: DirectoryArchiveBuild;
  activeDownloads: Set<ArtifactDownload>;
  cleanupRequested: boolean;
  timer: ReturnType<typeof setTimeout>;
};

type ArtifactTrackingState = {
  artifacts: Map<string, ArtifactEntry>;
  uploads: Map<string, UploadEntry>;
};

const ARTIFACT_TRACKING_SLOT = Symbol('artifactTracking');
const artifactTracking = (): ArtifactTrackingState =>
  runtimeSlot(
    ARTIFACT_TRACKING_SLOT,
    (): ArtifactTrackingState => ({ artifacts: new Map(), uploads: new Map() }),
    (state) => {
      for (const [id, entry] of state.artifacts) {
        requestArtifactCleanup(state.artifacts, id, entry);
        for (const download of entry.activeDownloads) cancelArtifactDownload(id, entry, download);
      }
      for (const entry of state.uploads.values()) {
        clearTimeout(entry.timer);
        removeBestEffort(entry.tempDir);
      }
    },
  );
const pendingArtifacts = () => artifactTracking().artifacts;
const pendingUploads = () => artifactTracking().uploads;

/** What a finished request registers for each artifact it hands back to the client. */
export type DownloadableArtifactRegistration = {
  artifactPath: string;
  tenantId?: string;
  artifactType: DaemonArtifactType | undefined;
  fileName?: string;
  displayRotation?: DeviceRotation;
  /** Public session name, for an artifact registered outside a request reply. */
  sessionName?: string;
  deleteAfterDownload?: boolean;
};

export type TrackDownloadableArtifact = (registration: DownloadableArtifactRegistration) => string;

type PreparedDownloadableArtifact = {
  artifactPath: string;
  fileName?: string;
  mimeType: string;
  sizeBytes: number;
};

export type OpenedDownloadableArtifact = PreparedDownloadableArtifact & {
  stream: fs.ReadStream;
  signal: AbortSignal;
  /** Release ownership after the download pipeline settles, including failure. */
  release: () => void;
};

/**
 * Registers one file for download and returns its id. A file the same tenant can already download
 * returns its existing entry unchanged: two ids for one file would each delete it after their own
 * download.
 */
export function trackDownloadableArtifact(params: DownloadableArtifactRegistration): string {
  const existingId = findTrackedArtifactId(params.artifactPath, params.tenantId);
  if (existingId) return existingId;
  const artifactId = crypto.randomUUID();
  const createdAt = Date.now();
  const timer = setTimeout(() => {
    cleanupDownloadableArtifact(artifactId);
  }, ARTIFACT_CLEANUP_TIMEOUT_MS);
  timer.unref();
  const sourceCleanup = findArtifactSourceCleanup(params.artifactPath) ?? {
    remainingEntries: 0,
    deleteAfterDownload: true,
  };
  sourceCleanup.remainingEntries += 1;
  sourceCleanup.deleteAfterDownload &&= params.deleteAfterDownload !== false;
  pendingArtifacts().set(artifactId, {
    artifactPath: params.artifactPath,
    tenantId: params.tenantId,
    artifactType: params.artifactType,
    fileName: params.fileName,
    ...(params.displayRotation !== undefined ? { displayRotation: params.displayRotation } : {}),
    ...(params.sessionName !== undefined ? { sessionName: params.sessionName } : {}),
    sourceCleanup,
    activeDownloads: new Set(),
    cleanupRequested: false,
    createdAt,
    timer,
  });
  return artifactId;
}

function findTrackedArtifactId(
  artifactPath: string,
  tenantId: string | undefined,
): string | undefined {
  for (const [artifactId, entry] of pendingArtifacts()) {
    if (
      !entry.cleanupRequested &&
      entry.artifactPath === artifactPath &&
      entry.tenantId === tenantId
    )
      return artifactId;
  }
  return undefined;
}

function findArtifactSourceCleanup(artifactPath: string): ArtifactSourceCleanup | undefined {
  for (const entry of pendingArtifacts().values()) {
    if (entry.artifactPath === artifactPath) return entry.sourceCleanup;
  }
  return undefined;
}

export async function openDownloadableArtifact(
  artifactId: string,
  tenantId: string | undefined,
  hostEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<OpenedDownloadableArtifact> {
  if (signal?.aborted) throw createRequestCanceledError();
  const artifacts = pendingArtifacts();
  const { entry, stat } = readDownloadableArtifactEntry(artifactId, tenantId);
  const download: ArtifactDownload = {
    controller: new AbortController(),
    release: () => {
      if (!entry.activeDownloads.delete(download)) return;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
      if (entry.cleanupRequested) requestArtifactCleanup(artifacts, artifactId, entry);
    },
  };
  entry.activeDownloads.add(download);
  const deadline = setTimeout(
    () => cancelArtifactDownload(artifactId, entry, download),
    ARTIFACT_DOWNLOAD_MAX_LIFETIME_MS,
  );
  deadline.unref();
  const cancel = () =>
    cancelArtifactDownload(artifactId, entry, download, createRequestCanceledError());
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    download.controller.signal.throwIfAborted();
    const payload = await prepareArtifactPayload(artifactId, entry, stat, hostEnv);
    download.controller.signal.throwIfAborted();
    if (!payload) {
      throw new AppError(
        'COMMAND_FAILED',
        `Artifact path is not a regular file or directory: ${entry.artifactPath}`,
      );
    }
    const stream = fs.createReadStream(payload.artifactPath);
    download.stream = stream;
    return { ...payload, stream, signal: download.controller.signal, release: download.release };
  } catch (error) {
    download.release();
    throw error;
  }
}

function cancelArtifactDownload(
  artifactId: string,
  entry: ArtifactEntry,
  download: ArtifactDownload,
  reason: unknown = expiredTenantOwnedEntryError(DOWNLOADABLE_ARTIFACT_RESOURCE, artifactId),
): void {
  if (!entry.activeDownloads.has(download)) return;
  download.controller.abort(reason);
  if (!download.stream) {
    if ([...entry.activeDownloads].every(({ controller }) => controller.signal.aborted)) {
      entry.directoryArchiveBuild?.controller.abort(reason);
    }
    return;
  }
  const closed = finished(download.stream, { cleanup: true }).catch(() => {});
  download.stream.destroy();
  void closed.then(download.release);
}

export async function listDownloadableArtifacts(
  tenantId: string | undefined,
  hostEnv: NodeJS.ProcessEnv,
): Promise<DaemonArtifactInventoryEntry[]> {
  const artifacts: DaemonArtifactInventoryEntry[] = [];
  for (const [id, entry] of pendingArtifacts()) {
    if (!canReadArtifact(entry, tenantId)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entry.artifactPath);
    } catch {
      cleanupDownloadableArtifact(id);
      continue;
    }
    const payload = await prepareArtifactPayloadForInventory(id, entry, stat, hostEnv);
    if (!payload || entry.cleanupRequested) continue;
    artifacts.push({
      id,
      ...(entry.artifactType !== undefined ? { artifactType: entry.artifactType } : {}),
      filename: payload.fileName ?? id,
      mimeType: payload.mimeType,
      sizeBytes: payload.sizeBytes,
      createdAt: new Date(entry.createdAt).toISOString(),
      expiresAt: new Date(entry.createdAt + ARTIFACT_CLEANUP_TIMEOUT_MS).toISOString(),
      ...(entry.displayRotation !== undefined ? { displayRotation: entry.displayRotation } : {}),
      ...(entry.sessionName !== undefined ? { sessionName: entry.sessionName } : {}),
    });
  }
  return artifacts;
}

async function prepareArtifactPayloadForInventory(
  artifactId: string,
  entry: ArtifactEntry,
  stat: fs.Stats,
  hostEnv: NodeJS.ProcessEnv,
): Promise<PreparedDownloadableArtifact | null> {
  try {
    return await prepareArtifactPayload(artifactId, entry, stat, hostEnv);
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
    pendingArtifacts(),
    artifactId,
    tenantId,
    DOWNLOADABLE_ARTIFACT_RESOURCE,
  );
  if (entry.cleanupRequested) {
    throw expiredTenantOwnedEntryError(DOWNLOADABLE_ARTIFACT_RESOURCE, artifactId);
  }
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
  hostEnv: NodeJS.ProcessEnv,
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

  const directoryArchive = await ensureDirectoryArchive(artifactId, entry, hostEnv);
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
  hostEnv: NodeJS.ProcessEnv,
): Promise<DirectoryArchive> {
  if (entry.directoryArchive && fs.existsSync(entry.directoryArchive.archivePath)) {
    return entry.directoryArchive;
  }
  const currentBuild = entry.directoryArchiveBuild;
  if (currentBuild && !currentBuild.controller.signal.aborted) {
    return await currentBuild.promise;
  }

  const controller = new AbortController();
  const archivePromise = createDirectoryArchive(artifactId, entry, hostEnv, controller);
  const build = { promise: archivePromise, controller };
  entry.directoryArchiveBuild = build;
  try {
    return await archivePromise;
  } finally {
    if (entry.directoryArchiveBuild === build) {
      entry.directoryArchiveBuild = undefined;
    }
  }
}

async function createDirectoryArchive(
  artifactId: string,
  entry: ArtifactEntry,
  hostEnv: NodeJS.ProcessEnv,
  controller: AbortController,
): Promise<DirectoryArchive> {
  let tempDir: string | undefined;
  try {
    cleanupDirectoryArchive(entry);

    const sourceName = safeArtifactFilename(
      entry.fileName,
      path.basename(entry.artifactPath) || artifactId,
    );
    const fileName = archiveFilename(sourceName);
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `agent-device-download-${crypto.randomUUID()}-`),
    );
    const archivePath = path.join(tempDir, fileName);
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
        signal: controller.signal,
        timeoutMs: ARTIFACT_DOWNLOAD_MAX_LIFETIME_MS,
        env: {
          ...hostEnv,
          COPYFILE_DISABLE: '1',
        },
      },
    );
    controller.signal.throwIfAborted();
    const archive = {
      archivePath,
      tempDir,
      fileName,
      sizeBytes: fs.statSync(archivePath).size,
    };
    entry.directoryArchive = archive;
    return archive;
  } catch (error) {
    const failure = controller.signal.aborted
      ? controller.signal.reason
      : error instanceof AppError
        ? error
        : new AppError(
            'COMMAND_FAILED',
            `Failed to archive downloadable artifact: ${entry.artifactPath}`,
            { artifactPath: entry.artifactPath },
            error instanceof Error ? error : undefined,
          );
    controller.abort(failure);
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    throw failure;
  } finally {
    if (entry.directoryArchiveBuild?.controller === controller) {
      entry.directoryArchiveBuild = undefined;
    }
  }
}

function archiveFilename(fileName: string): string {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.tar.gz') || lowered.endsWith('.tgz')) return fileName;
  return `${fileName}.tar.gz`;
}

function canReadArtifact(entry: ArtifactEntry, tenantId: string | undefined): boolean {
  return !entry.cleanupRequested && (!entry.tenantId || entry.tenantId === tenantId);
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
  const artifacts = pendingArtifacts();
  const entry = artifacts.get(artifactId);
  if (!entry) return;
  requestArtifactCleanup(artifacts, artifactId, entry);
}

function requestArtifactCleanup(
  artifacts: Map<string, ArtifactEntry>,
  artifactId: string,
  entry: ArtifactEntry,
): void {
  entry.cleanupRequested = true;
  clearTimeout(entry.timer);
  if (entry.activeDownloads.size > 0 || artifacts.get(artifactId) !== entry) return;
  entry.directoryArchiveBuild?.controller.abort(
    expiredTenantOwnedEntryError(DOWNLOADABLE_ARTIFACT_RESOURCE, artifactId),
  );
  artifacts.delete(artifactId);
  cleanupDirectoryArchive(entry);
  entry.sourceCleanup.remainingEntries -= 1;
  if (entry.sourceCleanup.remainingEntries === 0 && entry.sourceCleanup.deleteAfterDownload) {
    removeBestEffort(entry.artifactPath);
  }
}

function removeBestEffort(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

function cleanupDirectoryArchive(entry: ArtifactEntry): void {
  if (!entry.directoryArchive) return;
  removeBestEffort(entry.directoryArchive.tempDir);
  entry.directoryArchive = undefined;
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
  pendingUploads().set(uploadId, {
    artifactPath: params.artifactPath,
    tempDir: params.tempDir,
    tenantId: params.tenantId,
    timer,
  });
  return uploadId;
}

export function prepareUploadedArtifact(uploadId: string, tenantId?: string): string {
  const entry = requireTenantOwnedEntry(
    pendingUploads(),
    uploadId,
    tenantId,
    UPLOADED_ARTIFACT_RESOURCE,
  );
  clearTimeout(entry.timer);
  return entry.artifactPath;
}

export function cleanupUploadedArtifact(uploadId: string): void {
  const entry = pendingUploads().get(uploadId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingUploads().delete(uploadId);
  fs.rmSync(entry.tempDir, { recursive: true, force: true });
}
