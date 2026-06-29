import crypto from 'node:crypto';
import fs from 'node:fs';
import { AppError } from '../kernel/errors.ts';

// --- Downloadable artifact tracking ---

const ARTIFACT_CLEANUP_TIMEOUT_MS = 15 * 60 * 1000;

type ArtifactEntry = {
  artifactPath: string;
  tenantId?: string;
  fileName?: string;
  deleteAfterDownload: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const pendingArtifacts = new Map<string, ArtifactEntry>();

export function trackDownloadableArtifact(params: {
  artifactPath: string;
  tenantId?: string;
  fileName?: string;
  deleteAfterDownload?: boolean;
}): string {
  const artifactId = crypto.randomUUID();
  const timer = setTimeout(() => {
    cleanupDownloadableArtifact(artifactId);
  }, ARTIFACT_CLEANUP_TIMEOUT_MS);
  timer.unref();
  pendingArtifacts.set(artifactId, {
    artifactPath: params.artifactPath,
    tenantId: params.tenantId,
    fileName: params.fileName,
    deleteAfterDownload: params.deleteAfterDownload !== false,
    timer,
  });
  return artifactId;
}

export function prepareDownloadableArtifact(
  artifactId: string,
  tenantId?: string,
): { artifactPath: string; fileName?: string; deleteAfterDownload: boolean } {
  const entry = pendingArtifacts.get(artifactId);
  if (!entry) {
    throw new AppError('INVALID_ARGS', `Artifact not found: ${artifactId}`);
  }
  if (entry.tenantId && entry.tenantId !== tenantId) {
    throw new AppError('UNAUTHORIZED', 'Artifact belongs to a different tenant');
  }
  if (!fs.existsSync(entry.artifactPath)) {
    cleanupDownloadableArtifact(artifactId);
    throw new AppError('COMMAND_FAILED', `Artifact file is missing: ${entry.artifactPath}`);
  }
  return {
    artifactPath: entry.artifactPath,
    fileName: entry.fileName,
    deleteAfterDownload: entry.deleteAfterDownload,
  };
}

export function cleanupDownloadableArtifact(artifactId: string): void {
  const entry = pendingArtifacts.get(artifactId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingArtifacts.delete(artifactId);
  if (!entry.deleteAfterDownload) return;
  try {
    fs.rmSync(entry.artifactPath, { force: true });
  } catch {
    // best-effort cleanup only
  }
}

// --- Upload artifact tracking ---

const UPLOAD_CLEANUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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
  const entry = pendingUploads.get(uploadId);
  if (!entry) {
    throw new AppError('INVALID_ARGS', `Uploaded artifact not found: ${uploadId}`);
  }
  if (entry.tenantId && entry.tenantId !== tenantId) {
    throw new AppError('UNAUTHORIZED', 'Uploaded artifact belongs to a different tenant');
  }
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
