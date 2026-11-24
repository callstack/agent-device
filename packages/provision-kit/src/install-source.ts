import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonInstallSource } from '@agent-device/kernel/contracts';
import {
  AppError,
  createRequestCanceledError,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import { ArchiveBudget } from '@agent-device/host-kit/archive';
import { expandUserHomePath } from '@agent-device/host-kit/path-resolution';

import { resolveInstallableCandidate } from './install-source-archive.ts';
import {
  installArtifactArchiveBudget,
  noteInstallArtifactArchiveDepth,
} from './install-artifact-archive-context.ts';
import { approveDownloadSourceUrl } from './install-source-network.ts';
import { downloadInstallSource, invalidSourceUrlError } from './install-source-download.ts';

export type MaterializeInstallableOptions = {
  source: DaemonInstallSource;
  isInstallablePath: (
    candidatePath: string,
    stat: { isFile(): boolean; isDirectory(): boolean },
  ) => boolean;
  installableLabel: string;
  /** Request cancellation. The materialization deadline is a separate, self-armed timer. */
  signal?: AbortSignal;
  /**
   * The epoch-ms cutoff the daemon derived for this transfer (#4441). This call arms one timer for
   * it and reports its expiry as `source_materialization_deadline_exceeded` with the armed
   * timeout. It never extends the standalone aggregate.
   */
  materializationDeadlineMs?: number;
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
 * download and extraction. A caller's own earlier deadline always wins over this one: the daemon
 * hands the request's cutoff (its earliest registered deadline less the deploy-ledger reserve) to
 * `options.materializationDeadlineMs`, and any standalone caller may pass its own signal. The
 * aggregate only keeps the API from silently becoming an unbounded download (#4441).
 */
export const SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS = 600_000;

/** Why a standalone source-materialization call gives up. */
const INSTALL_SOURCE_REASONS = {
  // The aggregate or handed-down materialization budget ran out before the source was ready.
  materializationDeadline: { reason: 'source_materialization_deadline_exceeded' },
} as const satisfies ReasonTable<'install-from-source'>;

/** The error of an expired materialization deadline, labeled with the timeout actually armed. */
function sourceMaterializationDeadlineError(timeoutMs: number, cause?: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `App source materialization timed out after ${timeoutMs}ms`,
    {
      reason: INSTALL_SOURCE_REASONS.materializationDeadline.reason,
      transferPhase: 'materialization',
      timeoutMs,
    },
    cause,
  );
}

/** The timer that ends materialization: the armed budget and the error its expiry reports. */
type MaterializationDeadline = {
  signal: AbortSignal;
  /** The timeout this deadline armed, which its expiry must report. */
  timeoutMs: number;
  /** Whether an abort reason is this deadline's own expiry, not a caller cancellation. */
  isDeadlineAbort(reason: unknown): boolean;
  deadlineError(cause?: unknown): AppError;
};

function createMaterializationDeadline(
  aggregateSignal: AbortSignal,
  aggregateTimeoutMs: number,
  materializationDeadlineMs: number | undefined,
): MaterializationDeadline {
  if (materializationDeadlineMs === undefined) {
    return {
      signal: aggregateSignal,
      timeoutMs: aggregateTimeoutMs,
      isDeadlineAbort: (reason) => aggregateSignal.aborted && reason === aggregateSignal.reason,
      deadlineError: (cause) => sourceMaterializationDeadlineError(aggregateTimeoutMs, cause),
    };
  }
  // One timer the materializer owns, armed at the daemon's remaining budget and never longer than
  // the standalone aggregate. Its expiry is classified by identity against this signal's own
  // reason, so the reported timeout is the armed value wherever the abort surfaces (#4726).
  const timeoutMs = Math.min(
    aggregateTimeoutMs,
    Math.max(0, materializationDeadlineMs - Date.now()),
  );
  if (timeoutMs <= 0) {
    // The cutoff already passed (a cold boot consumed the budget). Fail at once through an
    // already-aborted signal instead of racing a zero timer against the first IO.
    const spent = new AbortController();
    const reason = sourceMaterializationDeadlineError(0);
    spent.abort(reason);
    return {
      signal: AbortSignal.any([aggregateSignal, spent.signal]),
      timeoutMs: 0,
      isDeadlineAbort: (candidate) => candidate === spent.signal.reason,
      deadlineError: (cause) => sourceMaterializationDeadlineError(0, cause),
    };
  }
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: AbortSignal.any([aggregateSignal, deadlineSignal]),
    timeoutMs,
    isDeadlineAbort: (reason) => deadlineSignal.aborted && reason === deadlineSignal.reason,
    deadlineError: (cause) => sourceMaterializationDeadlineError(timeoutMs, cause),
  };
}

export async function materializeInstallablePath(
  options: MaterializeInstallableOptions,
): Promise<MaterializedInstallable> {
  const aggregateSignal = AbortSignal.timeout(SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS);
  const deadline = createMaterializationDeadline(
    aggregateSignal,
    SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS,
    options.materializationDeadlineMs,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const deadlineAt = performance.now() + deadline.timeoutMs;
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
    if (performance.now() >= deadlineAt) throw deadline.deadlineError();
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
    const failure = await classifyMaterializationError(error, signal, deadline);
    await runCleanupTasks(cleanupTasks);
    throw failure;
  }
}

function expandSourcePath(inputPath: string, env: NodeJS.ProcessEnv): string {
  return expandUserHomePath(inputPath, { env });
}

async function materializeLocalSource(
  source: DaemonInstallSource,
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
  deadline: MaterializationDeadline,
): Promise<unknown> {
  // Keep the transport owner outside the CLI's eager import closure (ADR 0027).
  const { isTransferPhaseTimeoutError } = await import('@agent-device/host-kit/transport');
  if (isTransferPhaseTimeoutError(error)) return error;
  if (!signal.aborted) return error;
  // Only an abort-shaped failure (the signal's own reason, or an error caused by it) is
  // relabeled; a typed failure that merely raced an abort during cleanup stays itself.
  const reason = signal.reason;
  const abortShaped = error === reason || (error instanceof Error && error.cause === reason);
  if (!abortShaped) return error;
  // Any timer-driven materialization abort — the standalone aggregate or the daemon cutoff — is
  // the deadline, labeled with the timeout actually armed. Only a real request cancellation, whose
  // reason is a distinct signal's, reports `request_canceled` (#4726).
  if (deadline.isDeadlineAbort(reason)) return deadline.deadlineError(error);
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
