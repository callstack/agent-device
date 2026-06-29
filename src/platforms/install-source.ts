import dns from 'node:dns/promises';
import net from 'node:net';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../kernel/errors.ts';
import { runCmd } from '../utils/exec.ts';
import { expandUserHomePath } from '../utils/path-resolution.ts';

export type MaterializeInstallSource =
  | {
      kind: 'url';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      kind: 'path';
      path: string;
    };

type MaterializeLocalSourceResult = {
  localPath: string;
  cleanup: () => Promise<void>;
};

type MaterializeInstallableOptions = {
  source: MaterializeInstallSource;
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

export const ARCHIVE_EXTENSIONS = Object.freeze([...INTERNAL_ARCHIVE_EXTENSIONS] as const);
const MAX_INSTALL_SOURCE_SEARCH_DEPTH = 5;
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
  source: MaterializeInstallSource,
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

// fallow-ignore-next-line complexity
async function downloadToTempFile(
  tempDir: string,
  url: string,
  headers?: Record<string, string>,
  options?: { signal?: AbortSignal; downloadTimeoutMs?: number },
): Promise<string> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AppError('INVALID_ARGS', `Invalid source URL: ${url}`);
  }
  await validateDownloadSourceUrl(parsedUrl);
  const requestSignal = options?.signal;
  if (requestSignal?.aborted) {
    throw new AppError('COMMAND_FAILED', 'request canceled', { reason: 'request_canceled' });
  }
  const timeoutMs = options?.downloadTimeoutMs ?? DEFAULT_SOURCE_DOWNLOAD_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await fetch(parsedUrl, {
      headers,
      redirect: 'follow',
      signal,
    });
    if (!response.ok) {
      throw new AppError(
        'COMMAND_FAILED',
        `Failed to download app source: ${response.status} ${response.statusText}`,
        {
          status: response.status,
          statusText: response.statusText,
          url: parsedUrl.toString(),
        },
      );
    }
    const downloadName = resolveDownloadFileName(response, parsedUrl);
    const destinationPath = path.join(tempDir, downloadName);
    const body = response.body;
    if (!body) {
      throw new AppError('COMMAND_FAILED', 'Download response body was empty', {
        url: parsedUrl.toString(),
      });
    }
    await pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(destinationPath),
    );
    return destinationPath;
  } catch (error) {
    if (requestSignal?.aborted) {
      throw new AppError(
        'COMMAND_FAILED',
        'request canceled',
        { reason: 'request_canceled' },
        error,
      );
    }
    if (timeoutSignal.aborted) {
      throw new AppError(
        'COMMAND_FAILED',
        `App source download timed out after ${timeoutMs}ms`,
        {
          timeoutMs,
          url: parsedUrl.toString(),
        },
        error,
      );
    }
    throw error;
  }
}

export async function validateDownloadSourceUrl(parsedUrl: URL): Promise<void> {
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new AppError('INVALID_ARGS', `Unsupported source URL protocol: ${parsedUrl.protocol}`);
  }
  const hostname = parsedUrl.hostname.toLowerCase();
  if (isBlockedSourceHostname(hostname)) {
    throw new AppError('INVALID_ARGS', `Source URL host is not allowed: ${parsedUrl.hostname}`, {
      hint: 'Use a public artifact URL.',
    });
  }

  const resolved = await dns
    .lookup(parsedUrl.hostname, { all: true, verbatim: true })
    .catch(() => []);
  if (resolved.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new AppError(
      'INVALID_ARGS',
      `Source URL host resolved to a private or loopback address: ${parsedUrl.hostname}`,
      {
        hint: 'Use a public artifact URL.',
      },
    );
  }
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

function resolveDownloadFileName(response: Response, parsedUrl: URL): string {
  const contentDisposition = response.headers.get('content-disposition');
  const filenameMatch = contentDisposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const headerName = filenameMatch?.[1]?.trim();
  if (headerName) return path.basename(headerName);
  const urlName = path.basename(parsedUrl.pathname);
  if (urlName) return urlName;
  return 'downloaded-artifact.bin';
}

export function isBlockedSourceHostname(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return isBlockedIpAddress(hostname);
}

export function isBlockedIpAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return false;
}

// fallow-ignore-next-line complexity
function isBlockedIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  const a = octets[0];
  const b = octets[1];
  if (a === undefined || b === undefined) return false;
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80:')) return true;
  return false;
}

// fallow-ignore-next-line complexity
async function resolveInstallableCandidate(
  candidatePath: string,
  params: {
    archivePath: string | undefined;
    isInstallablePath: MaterializeInstallableOptions['isInstallablePath'];
    installableLabel: string;
    allowArchiveExtraction: boolean;
    registerCleanup: (cleanup: () => Promise<void>) => void;
  },
): Promise<{ archivePath?: string; installablePath: string }> {
  const stat = await fs.stat(candidatePath).catch(() => null);
  if (!stat) {
    throw new AppError('INVALID_ARGS', `App source not found: ${candidatePath}`);
  }

  if (params.isInstallablePath(candidatePath, stat)) {
    return {
      archivePath: params.archivePath,
      installablePath: candidatePath,
    };
  }

  if (stat.isFile() && isArchivePath(candidatePath)) {
    if (!params.allowArchiveExtraction) {
      throw new AppError(
        'INVALID_ARGS',
        `URL sources must point directly to a ${params.installableLabel}; archive extraction is not allowed`,
        { path: candidatePath },
      );
    }
    const extracted = await extractArchive(candidatePath);
    params.registerCleanup(extracted.cleanup);
    return await resolveInstallableCandidate(extracted.outputPath, {
      ...params,
      archivePath: params.archivePath ?? candidatePath,
    });
  }

  if (stat.isDirectory()) {
    const installables = await collectMatchingPaths(candidatePath, params.isInstallablePath);
    const installable = installables[0];
    if (installable !== undefined && installables.length === 1) {
      return {
        archivePath: params.archivePath,
        installablePath: installable,
      };
    }
    if (installables.length > 1) {
      throw new AppError(
        'INVALID_ARGS',
        `Found multiple ${params.installableLabel} candidates under ${candidatePath}`,
        { matches: installables },
      );
    }

    const archives = await collectMatchingPaths(
      candidatePath,
      (entryPath, entryStat) => entryStat.isFile() && isArchivePath(entryPath),
    );
    const archive = archives[0];
    if (archive !== undefined && archives.length === 1) {
      if (!params.allowArchiveExtraction) {
        throw new AppError(
          'INVALID_ARGS',
          `URL sources must point directly to a ${params.installableLabel}; nested archives are not allowed`,
          { path: archive },
        );
      }
      const extracted = await extractArchive(archive);
      params.registerCleanup(extracted.cleanup);
      return await resolveInstallableCandidate(extracted.outputPath, {
        ...params,
        archivePath: params.archivePath ?? archive,
      });
    }
    if (archives.length > 1) {
      throw new AppError(
        'INVALID_ARGS',
        `Found multiple nested archives under ${candidatePath}; expected one ${params.installableLabel} source`,
        { matches: archives },
      );
    }
  }

  throw new AppError(
    'INVALID_ARGS',
    `Expected ${params.installableLabel} source, but got ${candidatePath}`,
  );
}

async function collectMatchingPaths(
  rootPath: string,
  matcher: (candidatePath: string, stat: { isFile(): boolean; isDirectory(): boolean }) => boolean,
): Promise<string[]> {
  const matches: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const entries = await fs.readdir(current.path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(current.path, entry.name);
      if (matcher(entryPath, entry)) {
        matches.push(entryPath);
        continue;
      }
      if (entry.isDirectory() && current.depth < MAX_INSTALL_SOURCE_SEARCH_DEPTH) {
        queue.push({ path: entryPath, depth: current.depth + 1 });
      }
    }
  }

  return matches;
}

async function extractArchive(
  archivePath: string,
): Promise<{ outputPath: string; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-archive-'));
  try {
    if (archivePath.toLowerCase().endsWith('.zip')) {
      await extractZipArchive(archivePath, tempDir);
    } else if (
      archivePath.toLowerCase().endsWith('.tar.gz') ||
      archivePath.toLowerCase().endsWith('.tgz')
    ) {
      await runCmd('tar', ['-xzf', archivePath, '-C', tempDir]);
    } else {
      await runCmd('tar', ['-xf', archivePath, '-C', tempDir]);
    }
    return {
      outputPath: tempDir,
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function extractZipArchive(archivePath: string, outputPath: string): Promise<void> {
  await runCmd('unzip', ['-q', archivePath, '-d', outputPath]);
}

function isArchivePath(candidatePath: string): boolean {
  const lower = candidatePath.toLowerCase();
  return INTERNAL_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

async function runCleanupTasks(tasks: Array<() => Promise<void>>): Promise<void> {
  for (const task of [...tasks].reverse()) {
    await task();
  }
}
