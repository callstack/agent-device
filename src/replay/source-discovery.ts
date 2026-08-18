import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { resolveUserPath } from '../utils/path-resolution.ts';
import { isMaestroYamlPath, maestroBackendRequiredMessage } from './format.ts';

const GLOB_PATTERN_CHARS = /[*?[\]{}]/;
type ReplayInputSource = 'directory' | 'file' | 'glob';

/**
 * One traversal and ordering policy for both replay engines. It intentionally
 * matches Maestro: explicit files lead, directories use native DFS order, and
 * glob groups are extension-ranked then lexicographic.
 *
 * #1802: this runs on the CALLER. `test <path-or-glob>` names files on the
 * machine that typed the command, so expanding them daemon-side resolved
 * globs against the wrong filesystem entirely against a remote daemon; the
 * caller expands and then ships each source's text.
 */
export function discoverReplaySourcePaths(params: {
  inputs: string[];
  cwd: string;
  replayBackend?: string;
}): string[] {
  const extensions =
    params.replayBackend === 'maestro' ? new Set(['.yaml', '.yml', '.ad']) : new Set(['.ad']);
  const explicitFiles: string[] = [];
  const expandedGroups: string[][] = [];

  for (const input of params.inputs) {
    const expanded = expandReplayInput(input, params.cwd, extensions);
    if (expanded.source === 'file') {
      explicitFiles.push(...expanded.paths);
      continue;
    }
    expandedGroups.push(
      expanded.source === 'directory'
        ? uniqueNormalizedPaths(expanded.paths)
        : sortExpandedPaths(expanded.paths),
    );
  }
  return uniqueNormalizedPaths([...explicitFiles, ...expandedGroups.flat()]);
}

function expandReplayInput(
  input: string,
  cwd: string,
  extensions: ReadonlySet<string>,
): { paths: string[]; source: ReplayInputSource } {
  const expandedInput = resolveUserPath(input, { cwd });
  if (fs.existsSync(expandedInput)) {
    const stat = fs.statSync(expandedInput);
    if (stat.isDirectory()) {
      return {
        paths: readDirectoryPaths(expandedInput, extensions),
        source: 'directory',
      };
    }
    if (stat.isFile()) {
      assertSupportedReplayFile(input, expandedInput, extensions);
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
  return {
    source: 'glob',
    paths: matches
      .map((match) => (path.isAbsolute(match) ? match : path.resolve(cwd, match)))
      .filter(
        (match) => extensions.has(path.extname(match).toLowerCase()) && isExistingFile(match),
      ),
  };
}

function assertSupportedReplayFile(
  input: string,
  expandedInput: string,
  extensions: ReadonlySet<string>,
): void {
  if (extensions.has(path.extname(expandedInput).toLowerCase())) return;
  if (isMaestroYamlPath(expandedInput) && !extensions.has('.yaml')) {
    throw new AppError('INVALID_ARGS', maestroBackendRequiredMessage('test', input));
  }
  throw new AppError('INVALID_ARGS', `test does not support this file type: ${input}`);
}

function readDirectoryPaths(directoryPath: string, extensions: ReadonlySet<string>): string[] {
  const paths: string[] = [];
  const directory = fs.opendirSync(directoryPath);
  try {
    let entry: fs.Dirent | null;
    while ((entry = directory.readSync()) !== null) {
      const filePath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        paths.push(...readDirectoryPaths(filePath, extensions));
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        paths.push(filePath);
      }
    }
  } finally {
    directory.closeSync();
  }
  return paths;
}

function sortExpandedPaths(paths: string[]): string[] {
  return paths
    .map((entry) => path.normalize(entry))
    .sort((left, right) => {
      const rank = extensionRank(left) - extensionRank(right);
      return rank === 0 ? left.localeCompare(right) : rank;
    });
}

function extensionRank(filePath: string): number {
  return path.extname(filePath).toLowerCase() === '.ad' ? 1 : 0;
}

function uniqueNormalizedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => path.normalize(entry)))];
}

function looksLikeGlob(value: string): boolean {
  return GLOB_PATTERN_CHARS.test(value);
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
