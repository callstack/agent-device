import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LocalInstallSource } from '@agent-device/kernel/contracts';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { expandUserHomePath } from '../utils/path-resolution.ts';
import { ArchiveBudget } from '../utils/archive-safety.ts';
import { resolveInstallableCandidate } from './install-source-archive.ts';
import {
  installArtifactArchiveBudget,
  noteInstallArtifactArchiveDepth,
} from './install-artifact-archive-context.ts';
import { approveDownloadSourceUrl } from './install-source-network.ts';
import { downloadInstallSource } from './install-source-download.ts';

type MaterializeLocalSourceResult = {
  localPath: string;
  cleanup: () => Promise<void>;
};

export type MaterializeInstallableOptions = {
  source: LocalInstallSource;
  isInstallablePath: (
    candidatePath: string,
    stat: { isFile(): boolean; isDirectory(): boolean },
  ) => boolean;
  installableLabel: string;
  allowArchiveExtraction?: boolean;
  signal?: AbortSignal;
  downloadTimeoutMs?: number;
};

export type MaterializedInstallable = {
  archivePath?: string;
  installablePath: string;
  cleanup: () => Promise<void>;
};

const INTERNAL_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'] as const;

/**
 * @public Archive extensions accepted by install-source resolution.
 */
export const ARCHIVE_EXTENSIONS = Object.freeze([...INTERNAL_ARCHIVE_EXTENSIONS] as const);
const DEFAULT_SOURCE_DOWNLOAD_TIMEOUT_MS = 120_000;

export async function materializeInstallablePath(
  options: MaterializeInstallableOptions,
): Promise<MaterializedInstallable> {
  const cleanupTasks: Array<() => Promise<void>> = [];
  try {
    const localSource = await materializeLocalSource(options.source, {
      signal: options.signal,
      downloadTimeoutMs: options.downloadTimeoutMs,
    });
    cleanupTasks.push(localSource.cleanup);
    const resolved = await resolveInstallableCandidate(localSource.localPath, {
      archivePath: undefined,
      isInstallablePath: options.isInstallablePath,
      installableLabel: options.installableLabel,
      allowArchiveExtraction: options.allowArchiveExtraction !== false,
      registerCleanup: (cleanup) => {
        cleanupTasks.push(cleanup);
      },
      budget: (installArtifactArchiveBudget() as ArchiveBudget | undefined) ?? new ArchiveBudget(),
      archiveDepth: 0,
      onArchiveAccepted: noteInstallArtifactArchiveDepth,
    });
    return {
      archivePath: resolved.archivePath,
      installablePath: resolved.installablePath,
      cleanup: async () => {
        await runCleanupTasks(cleanupTasks);
      },
    };
  } catch (error) {
    await runCleanupTasks(cleanupTasks);
    throw error;
  }
}

function expandSourcePath(inputPath: string): string {
  return expandUserHomePath(inputPath);
}

async function materializeLocalSource(
  source: LocalInstallSource,
  options?: { signal?: AbortSignal; downloadTimeoutMs?: number },
): Promise<MaterializeLocalSourceResult> {
  if (source.kind === 'path') {
    return {
      localPath: expandSourcePath(source.path),
      cleanup: async () => {},
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-source-'));
  try {
    const downloadedPath = await downloadToTempFile(tempDir, source.url, source.headers, options);
    return {
      localPath: downloadedPath,
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function downloadToTempFile(
  tempDir: string,
  url: string,
  headers?: Record<string, string>,
  options?: { signal?: AbortSignal; downloadTimeoutMs?: number },
): Promise<string> {
  const requestSignal = options?.signal;
  if (requestSignal?.aborted) {
    throw createRequestCanceledError();
  }
  const timeoutMs = options?.downloadTimeoutMs ?? DEFAULT_SOURCE_DOWNLOAD_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
  try {
    return await downloadInstallSource({ tempDir, url, headers, signal });
  } catch (error) {
    throw classifyDownloadError(error, requestSignal, timeoutSignal, timeoutMs);
  }
}

function classifyDownloadError(
  error: unknown,
  requestSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): unknown {
  if (requestSignal?.aborted) {
    return createRequestCanceledError(undefined, error);
  }
  if (timeoutSignal.aborted) {
    return new AppError(
      'COMMAND_FAILED',
      `App source download timed out after ${timeoutMs}ms`,
      { timeoutMs },
      error,
    );
  }
  return error;
}

export async function validateDownloadSourceUrl(parsedUrl: URL): Promise<void> {
  await approveDownloadSourceUrl(parsedUrl);
}

export function isTrustedInstallSourceUrl(sourceUrl: string | URL): boolean {
  const parsed = sourceUrl instanceof URL ? sourceUrl : new URL(sourceUrl);
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return false;
  const pathname = parsed.pathname;
  return (
    isTrustedGithubActionsArtifactUrl(hostname, pathname) ||
    isTrustedEasArtifactUrl(hostname, pathname)
  );
}

function isTrustedGithubActionsArtifactUrl(hostname: string, pathname: string): boolean {
  if (hostname === 'api.github.com') {
    return /^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/\d+\/zip$/i.test(pathname);
  }
  if (hostname !== 'github.com') return false;
  return /^\/[^/]+\/[^/]+\/(?:actions\/runs\/\d+\/artifacts\/\d+|suites\/\d+\/artifacts\/\d+)$/i.test(
    pathname,
  );
}

function isTrustedEasArtifactUrl(hostname: string, pathname: string): boolean {
  if (hostname !== 'expo.dev' && !hostname.endsWith('.expo.dev')) {
    return false;
  }
  return /^\/(?:artifacts\/eas\/|accounts\/[^/]+\/projects\/[^/]+\/builds\/)/i.test(pathname);
}

async function runCleanupTasks(tasks: Array<() => Promise<void>>): Promise<void> {
  for (const task of [...tasks].reverse()) {
    await task();
  }
}
