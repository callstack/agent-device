import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LocalInstallSource } from '@agent-device/kernel/contracts';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { ArchiveBudget } from '@agent-device/host-kit/archive';
import { expandUserHomePath } from '@agent-device/host-kit/file';

import { resolveInstallableCandidate } from './install-source-archive.ts';
import {
  installArtifactArchiveBudget,
  noteInstallArtifactArchiveDepth,
} from './install-artifact-archive-context.ts';
import { approveDownloadSourceUrl } from './install-source-network.ts';
import { downloadInstallSource, invalidSourceUrlError } from './install-source-download.ts';

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
  signal?: AbortSignal;
  /** The host environment whose proxy settings apply to a network download. */
  environment: NodeJS.ProcessEnv;
};

export type MaterializedInstallable = {
  archivePath?: string;
  /** The archive the installable was extracted from directly, when it came out of one. */
  containingArchivePath?: string;
  installablePath: string;
  cleanup: () => Promise<void>;
};

const INTERNAL_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'] as const;

/**
 * @public Archive extensions accepted by install-source resolution.
 */
export const ARCHIVE_EXTENSIONS = Object.freeze([...INTERNAL_ARCHIVE_EXTENSIONS] as const);

/**
 * The finite aggregate a standalone source-materialization call spends from entry, covering
 * download and extraction. A caller's own earlier deadline (the shared request budget armed at
 * admission) always wins over this one; the aggregate only keeps the API from silently becoming an
 * unbounded download (#4441).
 */
export const SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS = 600_000;

const SOURCE_MATERIALIZATION_DEADLINE_REASON = 'source_materialization_deadline_exceeded';

function sourceMaterializationDeadlineError(cause?: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `App source materialization timed out after ${SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS}ms`,
    {
      reason: SOURCE_MATERIALIZATION_DEADLINE_REASON,
      transferPhase: 'materialization',
      timeoutMs: SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS,
    },
    cause,
  );
}

export async function materializeInstallablePath(
  options: MaterializeInstallableOptions,
): Promise<MaterializedInstallable> {
  const cleanupTasks: Array<() => Promise<void>> = [];
  const aggregateSignal = AbortSignal.timeout(SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, aggregateSignal])
    : aggregateSignal;
  try {
    const localSource = await materializeLocalSource(options.source, {
      signal,
      callerSignal: options.signal,
      aggregateSignal,
      environment: options.environment,
    });
    cleanupTasks.push(localSource.cleanup);
    const resolved = await resolveInstallableCandidate(localSource.localPath, {
      archivePath: undefined,
      isInstallablePath: options.isInstallablePath,
      installableLabel: options.installableLabel,
      registerCleanup: (cleanup) => {
        cleanupTasks.push(cleanup);
      },
      budget: (installArtifactArchiveBudget() as ArchiveBudget | undefined) ?? new ArchiveBudget(),
      archiveDepth: 0,
      onArchiveAccepted: noteInstallArtifactArchiveDepth,
      signal,
    });
    return {
      archivePath: resolved.archivePath,
      ...(resolved.containingArchivePath
        ? { containingArchivePath: resolved.containingArchivePath }
        : {}),
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

function expandSourcePath(inputPath: string, env: NodeJS.ProcessEnv): string {
  return expandUserHomePath(inputPath, { env });
}

async function materializeLocalSource(
  source: LocalInstallSource,
  options: {
    signal: AbortSignal;
    callerSignal?: AbortSignal;
    aggregateSignal: AbortSignal;
    environment: NodeJS.ProcessEnv;
  },
): Promise<MaterializeLocalSourceResult> {
  if (source.kind === 'path') {
    return {
      localPath: expandSourcePath(source.path, options.environment),
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
  headers: Record<string, string> | undefined,
  options: {
    signal: AbortSignal;
    callerSignal?: AbortSignal;
    aggregateSignal: AbortSignal;
    environment: NodeJS.ProcessEnv;
  },
): Promise<string> {
  if (options.signal.aborted) {
    throw await classifyDownloadError(options.signal.reason, options);
  }
  try {
    return await downloadInstallSource({
      tempDir,
      url,
      headers,
      signal: options.signal,
      environment: options.environment,
    });
  } catch (error) {
    throw await classifyDownloadError(error, options);
  }
}

/**
 * Keeps the typed first failure: caller cancellation stays cancellation, a transfer phase timeout
 * keeps its phase and budget, and only a standalone aggregate expiry is reported as such.
 */
async function classifyDownloadError(
  error: unknown,
  options: { callerSignal?: AbortSignal; aggregateSignal: AbortSignal },
): Promise<unknown> {
  if (options.callerSignal?.aborted) {
    return createRequestCanceledError(undefined, error);
  }
  // Loaded on demand: this module sits in the CLI's eager import closure, and the transport
  // owner must stay behind a function-scoped edge (ADR 0027).
  const { isTransferPhaseTimeoutError } = await import('@agent-device/host-kit/transport');
  if (isTransferPhaseTimeoutError(error)) {
    return error;
  }
  if (options.aggregateSignal.aborted) {
    return sourceMaterializationDeadlineError(error);
  }
  return error;
}

export async function validateDownloadSourceUrl(parsedUrl: URL): Promise<void> {
  await approveDownloadSourceUrl(parsedUrl);
}

/**
 * @deprecated agent-device does not gate install sources on this check: URL sources from any
 * public host may point at an installable or an archive containing one. This only classifies
 * whether a URL names a GitHub Actions or EAS artifact, which says nothing about who built it.
 */
export function isTrustedInstallSourceUrl(sourceUrl: string | URL): boolean {
  const parsed = sourceUrl instanceof URL ? sourceUrl : URL.parse(sourceUrl);
  if (!parsed) throw invalidSourceUrlError();
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
