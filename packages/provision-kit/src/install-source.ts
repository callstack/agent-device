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
  const deadlineAt = performance.now() + SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS;
  const aggregateSignal = AbortSignal.timeout(SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, aggregateSignal])
    : aggregateSignal;
  const cleanupTasks: Array<() => Promise<void>> = [];
  const registerCleanup = (cleanup: () => Promise<void>): void => {
    cleanupTasks.push(cleanup);
  };
  try {
    signal.throwIfAborted();
    const localPath = await materializeLocalSource(options.source, {
      signal,
      environment: options.environment,
      registerCleanup,
    });
    const resolved = await resolveInstallableCandidate(localPath, {
      archivePath: undefined,
      isInstallablePath: options.isInstallablePath,
      installableLabel: options.installableLabel,
      registerCleanup,
      budget: (installArtifactArchiveBudget() as ArchiveBudget | undefined) ?? new ArchiveBudget(),
      archiveDepth: 0,
      onArchiveAccepted: noteInstallArtifactArchiveDepth,
      signal,
    });
    signal.throwIfAborted();
    if (performance.now() >= deadlineAt) throw sourceMaterializationDeadlineError();
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
    const failure = await classifyMaterializationError(error, signal, aggregateSignal);
    await runCleanupTasks(cleanupTasks);
    throw failure;
  }
}

function expandSourcePath(inputPath: string, env: NodeJS.ProcessEnv): string {
  return expandUserHomePath(inputPath, { env });
}

async function materializeLocalSource(
  source: LocalInstallSource,
  options: {
    signal: AbortSignal;
    environment: NodeJS.ProcessEnv;
    registerCleanup: (cleanup: () => Promise<void>) => void;
  },
): Promise<string> {
  if (source.kind === 'path') return expandSourcePath(source.path, options.environment);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-source-'));
  options.registerCleanup(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  options.signal.throwIfAborted();
  return await downloadInstallSource({
    tempDir,
    url: source.url,
    headers: source.headers,
    signal: options.signal,
    environment: options.environment,
  });
}

async function classifyMaterializationError(
  error: unknown,
  signal: AbortSignal,
  aggregateSignal: AbortSignal,
): Promise<unknown> {
  if (!signal.aborted) return error;
  // Keep the transport owner outside the CLI's eager import closure (ADR 0027).
  const { isTransferPhaseTimeoutError } = await import('@agent-device/host-kit/transport');
  if (isTransferPhaseTimeoutError(error)) return error;
  if (aggregateSignal.aborted && signal.reason === aggregateSignal.reason) {
    return sourceMaterializationDeadlineError(error);
  }
  return createRequestCanceledError(undefined, error);
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
