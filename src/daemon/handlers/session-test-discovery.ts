import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../../kernel/errors.ts';
import { isApplePlatform, type PlatformSelector } from '../../kernel/device.ts';
import { resolveRequestTrackingId } from '../../request/cancel.ts';
import { SessionStore } from '../session-store.ts';
import { readReplayScriptMetadata, type ReplayScriptMetadata } from '../../replay/script.ts';
import { parseMaestroProgram } from '../../compat/maestro/program-ir-parser.ts';

const GLOB_PATTERN_CHARS = /[*?[\]{}]/;

const MAX_REPLAY_TEST_RETRIES = 3;

export type ReplayTestDiscoveryEntry =
  | {
      kind: 'run';
      path: string;
      title?: string;
      metadata: ReplayScriptMetadata;
    }
  | {
      kind: 'skip';
      path: string;
      reason: 'skipped-by-filter';
      message: string;
    };

export type ReplayTestRunEntry = Extract<ReplayTestDiscoveryEntry, { kind: 'run' }>;

type ReplayTestInputSource = 'directory' | 'file' | 'glob';

export function discoverReplayTestEntries(params: {
  inputs: string[];
  cwd?: string;
  platformFilter?: PlatformSelector;
  replayBackend?: string;
}): ReplayTestDiscoveryEntry[] {
  const { inputs, cwd, platformFilter, replayBackend } = params;
  const extensions = replayTestExtensions(replayBackend);
  const resolvedCwd = cwd ?? process.cwd();
  const filePaths = discoverReplayTestFilePaths(inputs, resolvedCwd, extensions, replayBackend);

  const entries: ReplayTestDiscoveryEntry[] = [];
  for (const filePath of filePaths) {
    const script = fs.readFileSync(filePath, 'utf8');
    const metadata = readReplayScriptMetadata(script);
    const title = readReplayTestTitle(script, filePath, replayBackend);
    if (!platformFilter) {
      entries.push({ kind: 'run', path: filePath, title, metadata });
      continue;
    }
    if (!metadata.platform) {
      if (isMaestroReplayBackend(replayBackend)) {
        entries.push({ kind: 'run', path: filePath, title, metadata });
      } else {
        entries.push({
          kind: 'skip',
          path: filePath,
          reason: 'skipped-by-filter',
          message: `missing platform metadata for --platform ${platformFilter}`,
        });
      }
      continue;
    }
    if (!matchesPlatformFilter(platformFilter, metadata.platform)) {
      continue;
    }
    entries.push({ kind: 'run', path: filePath, title, metadata });
  }

  const runnableCount = entries.filter((entry) => entry.kind === 'run').length;
  if (runnableCount === 0) {
    const suffix = platformFilter ? ` for --platform ${platformFilter}` : '';
    throw new AppError('INVALID_ARGS', `No replay tests matched${suffix}.`);
  }

  return entries;
}

export function buildReplayTestSessionName(
  sessionName: string,
  suiteInvocationId: string,
  filePath: string,
  caseIndex: number,
  attemptIndex = 0,
): string {
  const baseName = path.basename(filePath, path.extname(filePath));
  const slug = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const testNumber = caseIndex + 1;
  return `${sessionName}:test:${suiteInvocationId}:${testNumber}${slug ? `-${slug}` : ''}:attempt-${attemptIndex + 1}`;
}

export function buildReplayTestInvocationId(requestId?: string): string {
  const raw = requestId?.trim() || `${process.pid}-${Date.now().toString(36)}`;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'suite';
}

export function buildReplayTestAttemptRequestId(params: {
  requestId?: string;
  suiteInvocationId: string;
  filePath: string;
  caseIndex: number;
  attemptIndex: number;
  shardIndex?: number;
}): string {
  const { requestId, suiteInvocationId, filePath, caseIndex, attemptIndex, shardIndex } = params;
  const shardPart = shardIndex === undefined ? '' : `:shard:${shardIndex + 1}`;
  return resolveRequestTrackingId(
    `${requestId ?? suiteInvocationId}${shardPart}:test:${caseIndex + 1}:${path.basename(filePath)}:attempt:${attemptIndex + 1}`,
    suiteInvocationId,
  );
}

export function resolveReplayTestTimeout(
  cliTimeoutMs: unknown,
  metadataTimeoutMs: number | undefined,
): number | undefined {
  return typeof cliTimeoutMs === 'number' ? cliTimeoutMs : metadataTimeoutMs;
}

export function resolveReplayTestRetries(
  cliRetries: unknown,
  metadataRetries: number | undefined,
): number {
  const resolved = typeof cliRetries === 'number' ? cliRetries : metadataRetries;
  if (typeof resolved !== 'number') return 0;
  return Math.max(0, Math.min(MAX_REPLAY_TEST_RETRIES, resolved));
}

function discoverReplayTestFilePaths(
  inputs: string[],
  cwd: string,
  extensions: Set<string>,
  replayBackend: string | undefined,
): string[] {
  if (!isMaestroReplayBackend(replayBackend)) {
    return [
      ...new Set(inputs.flatMap((input) => expandReplayTestInput(input, cwd, extensions).paths)),
    ]
      .map((entry) => path.normalize(entry))
      .sort((left, right) => left.localeCompare(right));
  }

  const files: string[] = [];
  const expandedGroups: string[][] = [];
  for (const input of inputs) {
    const expanded = expandMaestroReplayTestInput(input, cwd, extensions);
    if (expanded.source === 'file') {
      files.push(...expanded.paths);
    } else {
      expandedGroups.push(
        expanded.source === 'directory'
          ? uniqueNormalizedPaths(expanded.paths)
          : sortMaestroExpandedReplayTestPaths(expanded.paths),
      );
    }
  }

  return uniqueNormalizedPaths([...files, ...expandedGroups.flat()]);
}

function expandMaestroReplayTestInput(
  input: string,
  cwd: string,
  extensions: Set<string>,
): { paths: string[]; source: ReplayTestInputSource } {
  const expandedInput = SessionStore.expandHome(input, cwd);
  if (fs.existsSync(expandedInput) && fs.statSync(expandedInput).isDirectory()) {
    return {
      paths: readMaestroDirectoryReplayTestPaths(expandedInput, extensions),
      source: 'directory',
    };
  }

  return expandReplayTestInput(input, cwd, extensions);
}

function readMaestroDirectoryReplayTestPaths(
  directoryPath: string,
  extensions: Set<string>,
): string[] {
  const paths: string[] = [];
  // Maestro's Java Files.walk follows native directory iteration order. Keep
  // this unsorted so folder suites, and sharding derived from them, match
  // Maestro on the same machine even though order can differ across hosts.
  const directory = fs.opendirSync(directoryPath);
  try {
    let entry: fs.Dirent | null;
    while ((entry = directory.readSync()) !== null) {
      const filePath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        paths.push(...readMaestroDirectoryReplayTestPaths(filePath, extensions));
      } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        paths.push(filePath);
      }
    }
  } finally {
    directory.closeSync();
  }
  return paths;
}

function expandReplayTestInput(
  input: string,
  cwd: string,
  extensions: Set<string>,
): { paths: string[]; source: ReplayTestInputSource } {
  const expandedInput = SessionStore.expandHome(input, cwd);
  if (fs.existsSync(expandedInput)) {
    const stat = fs.statSync(expandedInput);
    if (stat.isDirectory()) {
      const paths = replayTestGlobPatterns(extensions).flatMap((pattern) =>
        fs
          .globSync(pattern, { cwd: expandedInput })
          .map((match) => path.join(expandedInput, match)),
      );
      return { paths, source: 'directory' };
    }
    if (stat.isFile()) {
      if (!extensions.has(path.extname(expandedInput))) {
        throw new AppError('INVALID_ARGS', `test does not support this file type: ${input}`);
      }
      return { paths: [expandedInput], source: 'file' };
    }
    return { paths: [], source: 'file' };
  }

  if (!looksLikeGlob(input) && !looksLikeGlob(expandedInput)) {
    throw new AppError('INVALID_ARGS', `test input not found: ${input}`);
  }

  const pattern = path.isAbsolute(expandedInput) ? expandedInput : input;
  const matches = fs.globSync(pattern, {
    cwd: path.isAbsolute(expandedInput) ? undefined : cwd,
  });

  const paths = matches
    .map((match) => (path.isAbsolute(match) ? match : path.resolve(cwd, match)))
    .filter((match) => extensions.has(path.extname(match)) && isExistingFile(match));
  return { paths, source: 'glob' };
}

function replayTestExtensions(replayBackend: string | undefined): Set<string> {
  return isMaestroReplayBackend(replayBackend)
    ? new Set(['.yaml', '.yml', '.ad'])
    : new Set(['.ad']);
}

function replayTestGlobPatterns(extensions: Set<string>): string[] {
  return [...extensions].map((extension) => `**/*${extension}`);
}

function sortMaestroExpandedReplayTestPaths(paths: string[]): string[] {
  return paths.map((entry) => path.normalize(entry)).sort(compareMaestroReplayTestPath);
}

function compareMaestroReplayTestPath(left: string, right: string): number {
  const leftRank = maestroReplayTestExtensionRank(left);
  const rightRank = maestroReplayTestExtensionRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.localeCompare(right);
}

function maestroReplayTestExtensionRank(filePath: string): number {
  return path.extname(filePath) === '.ad' ? 1 : 0;
}

function uniqueNormalizedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => path.normalize(entry)))];
}

function isMaestroReplayBackend(replayBackend: string | undefined): boolean {
  return replayBackend === 'maestro';
}

function readReplayTestTitle(
  script: string,
  filePath: string,
  replayBackend: string | undefined,
): string | undefined {
  return isMaestroReplayBackend(replayBackend) && path.extname(filePath) !== '.ad'
    ? parseMaestroProgram(script, { sourcePath: filePath }).config.name
    : undefined;
}

function looksLikeGlob(value: string): boolean {
  return GLOB_PATTERN_CHARS.test(value);
}

function matchesPlatformFilter(filter: PlatformSelector, candidate: PlatformSelector): boolean {
  if (filter === 'apple') {
    return isApplePlatform(candidate);
  }
  return candidate === filter;
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
