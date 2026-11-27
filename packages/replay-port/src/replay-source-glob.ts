import fs from 'node:fs';
import path from 'node:path';

/**
 * Expands a `test <path-or-glob>` pattern without the `node:fs` glob call. That call is
 * experimental before Node 22.17 and Node 24, and the supported floor is 22.12, where every
 * call writes an ExperimentalWarning to stderr and pollutes CLI output.
 *
 * The walk keeps the rules the caller can observe through the patterns in use:
 * - A brace list expands into alternatives across separators first, so `flows/{a,b}/*.ad` and
 *   `{a,b}/x.ad` both reach the routes the author named. A group with one choice stays literal
 *   text, so a directory actually named `flows{a}` remains reachable.
 * - `/` and `\` both separate segments and neither escapes anything, as the glob call treats
 *   them. A `.` segment is dropped and a `..` segment is folded into the segment before it.
 * - A segment that names one entry keeps the authored spelling in the match. Above a `**` it is
 *   matched on the host's own case rules; below one it must match the entry name exactly. A segment
 *   with a wildcard keeps the entry's spelling and is matched on the host's own case rules.
 * - A name starting with a dot is reachable only through a segment whose own first character can
 *   be a dot: a literal `.`, or a class that leads with `.`.
 * - `**` stands for any run of directories, including none, to a bounded depth, and reports the
 *   route it walks. Below a trailing `**`, everything under a directory route is reported.
 * - A symbolic-linked directory is opened only by a segment that names one entry, and only while
 *   the walk has not crossed a `**`. A broken link is a route, but never a directory.
 * - A relative match keeps `/` separators, so the caller's resolve step against the working
 *   directory reaches the route the pattern named.
 *
 * Routes that name a directory rather than a file are kept, as the glob call keeps them; the
 * caller drops them with its own extension and regular-file filters.
 */

const SEGMENT_SEPARATOR = /[\\/]/;
// A segment holding one of these names more than one entry.
const WILDCARD_CHARACTERS = /[*?[]/;
const HIDDEN_PREFIX = '.';
/** One `**` run stands for at most this many directory levels. Replay suites sit a few deep. */
const MAX_GLOBSTAR_DEPTH = 64;
/** One pattern expands to at most this many brace alternatives. */
const MAX_BRACE_ALTERNATIVES = 64;

type GlobPatternSegment = {
  text: string;
  /** True when the segment is not one fixed name, so a symbolic link is never opened. */
  wildcard: boolean;
  globstar: boolean;
  /** True when the segment may name a hidden entry. */
  hiddenAllowed: boolean;
};

type GlobWalk = {
  segments: readonly GlobPatternSegment[];
  matches: Set<string>;
  /** Compiled matchers, keyed by compare mode and segment, kept for this expansion only. */
  matchers: Map<string, RegExp | undefined>;
};

export function expandReplaySourceGlob(pattern: string, cwd: string): string[] {
  const matches = new Set<string>();
  for (const alternative of braceAlternatives(pattern)) {
    expandBracedAlternative(alternative, cwd, matches);
  }
  return [...matches];
}

function expandBracedAlternative(pattern: string, cwd: string, matches: Set<string>): void {
  const root = resolveGlobRoot(pattern, cwd);
  if (!root) return;
  if (root.segments.length === 0) {
    // The whole alternative names one route, so the host answers whether it exists at all.
    if (routeExists(root.directory)) matches.add(root.route);
    return;
  }
  walkGlobRoute(
    { segments: root.segments, matches, matchers: new Map() },
    root.route,
    root.directory,
    0,
    0,
    false,
  );
}

type GlobRoot = {
  /** The route a match starts with, in the form the pattern authored it. */
  route: string;
  /** The same route resolved for the host, for the directory reads. */
  directory: string;
  segments: GlobPatternSegment[];
};

function resolveGlobRoot(pattern: string, cwd: string): GlobRoot | null {
  const parts = pattern.split(SEGMENT_SEPARATOR).filter((part) => part !== '');
  const kept = foldDotSegments(parts);
  if (kept.length === 0) return null;
  const segments = kept.map(globPatternSegment);
  const absolute = path.isAbsolute(pattern);
  let directory = absolute ? path.parse(pattern).root : cwd;
  let index = 0;
  // Each segment that names one entry fixes its own route, so the reads start at the deepest one
  // and only the segments that can name many entries are walked.
  for (; index < segments.length && !segments[index]!.wildcard; index += 1) {
    directory = path.join(directory, kept[index]!);
  }
  // A relative match keeps the route the pattern authored, joined with `/`. An absolute one keeps
  // the host's own separators, as the glob call returns for an absolute pattern.
  const authored = kept.slice(0, index).join('/') || '.';
  return {
    route: absolute ? path.normalize(directory) : authored,
    directory,
    segments: segments.slice(index),
  };
}

/** Drops `.` segments and folds each `..` into the segment before it, as the glob call does. */
function foldDotSegments(parts: readonly string[]): string[] {
  const kept: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..' && kept.length > 0 && kept.at(-1) !== '..') {
      kept.pop();
      continue;
    }
    kept.push(part);
  }
  return kept;
}

function globPatternSegment(text: string): GlobPatternSegment {
  const globstar = text === '**';
  return {
    text,
    globstar,
    wildcard: globstar || WILDCARD_CHARACTERS.test(text),
    hiddenAllowed: namesHiddenEntry(text),
  };
}

/**
 * Whether one brace-free segment can name a hidden entry. Only a segment whose own first
 * character can be a dot can reach one: a leading `.`, or a class that leads with `.`.
 */
function namesHiddenEntry(segment: string): boolean {
  if (segment.startsWith('[')) {
    const negated = segment[1] === '!' || segment[1] === '^';
    return segment[negated ? 2 : 1] === '.';
  }
  return segment.startsWith('.');
}

/**
 * Two rules change once the walk has crossed a `**` segment, and both hold on every supported Node:
 * a symbolic-linked directory is never opened, and a segment that names one entry is compared to
 * the entry name exactly, not on the host's own case rules.
 */
function walkGlobRoute(
  walk: GlobWalk,
  route: string,
  directory: string,
  index: number,
  globstarDepth: number,
  crossedGlobstar: boolean,
): void {
  const segment = walk.segments[index];
  if (!segment) return;
  const absoluteRoute = path.isAbsolute(directory);
  if (segment.globstar) {
    walkGlobRoute(walk, route, directory, index + 1, globstarDepth, true);
    // A trailing `**` reports the route it walks, then everything below it when it is a directory.
    if (index + 1 >= walk.segments.length) {
      if (routeExists(directory)) walk.matches.add(route);
      listDescendantRoutes(walk.matches, route, directory, absoluteRoute);
      return;
    }
    if (globstarDepth >= MAX_GLOBSTAR_DEPTH) return;
    for (const entry of readDirectoryEntries(directory)) {
      if (isHidden(entry.name) || !entry.isDirectory()) continue;
      walkGlobRoute(
        walk,
        joinRouteSegment(route, entry.name, absoluteRoute),
        path.join(directory, entry.name),
        index,
        globstarDepth + 1,
        true,
      );
    }
    return;
  }

  const lastSegment = index + 1 >= walk.segments.length;
  // A segment below a `**` that names one entry is compared to the entry name exactly. A segment
  // with a wildcard is always compared on the host's own case rules.
  const compareExactly = crossedGlobstar && !segment.wildcard;
  for (const entry of readDirectoryEntries(directory)) {
    if (isHidden(entry.name) && !segment.hiddenAllowed) continue;
    if (!segmentNamesEntry(entry.name, segment.text, compareExactly, walk.matchers)) continue;
    // A segment that names one entry keeps the spelling the caller authored.
    const named = segment.wildcard ? entry.name : segment.text;
    const childRoute = joinRouteSegment(route, named, absoluteRoute);
    const childDirectory = path.join(directory, entry.name);
    if (lastSegment) {
      walk.matches.add(childRoute);
      continue;
    }
    // Only a segment that names one entry opens a symbolic-linked directory.
    if (entryOpensDirectory(childDirectory, entry, segment.wildcard, !crossedGlobstar)) {
      walkGlobRoute(walk, childRoute, childDirectory, index + 1, globstarDepth, crossedGlobstar);
    }
  }
}

function listDescendantRoutes(
  matches: Set<string>,
  route: string,
  directory: string,
  absoluteRoute: boolean,
): void {
  for (const entry of readDirectoryEntries(directory)) {
    if (isHidden(entry.name)) continue;
    const childRoute = joinRouteSegment(route, entry.name, absoluteRoute);
    matches.add(childRoute);
    if (entry.isDirectory()) {
      listDescendantRoutes(matches, childRoute, path.join(directory, entry.name), absoluteRoute);
    }
  }
}

function entryOpensDirectory(
  candidate: string,
  entry: fs.Dirent,
  wildcard: boolean,
  opensSymbolicLinks: boolean,
): boolean {
  if (entry.isDirectory()) return true;
  if (wildcard || !opensSymbolicLinks || !entry.isSymbolicLink()) return false;
  try {
    // The link itself is never the directory: the walk follows it before it decides.
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function routeExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function readDirectoryEntries(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    // An unreadable route names no entry, so the pattern there matches nothing.
    return [];
  }
}

function isHidden(name: string): boolean {
  return name.startsWith(HIDDEN_PREFIX);
}

function joinRouteSegment(route: string, name: string, absolute: boolean): string {
  if (route === '' || route === '.') return name;
  return absolute ? path.join(route, name) : `${route}/${name}`;
}

const CASE_INSENSITIVE_PLATFORMS = new Set(['darwin', 'win32']);

function segmentNamesEntry(
  name: string,
  segment: string,
  compareExactly: boolean,
  matchers: Map<string, RegExp | undefined>,
): boolean {
  const key = `${compareExactly ? 'exact' : 'host'}:${segment}`;
  const cached = matchers.get(key);
  if (cached !== undefined) return cached.test(name);
  if (matchers.has(key)) return false;
  const flags = compareExactly || !CASE_INSENSITIVE_PLATFORMS.has(process.platform) ? '' : 'i';
  const body = translateSegment(segment);
  // A malformed segment, such as an unterminated character class, names no entry.
  const expression = body === null ? undefined : new RegExp(`^${body}$`, flags);
  matchers.set(key, expression);
  return expression !== undefined && expression.test(name);
}

/**
 * The pattern with its brace lists expanded into alternatives. A group with one choice is left in
 * place as literal text, as the glob call leaves it.
 */
function braceAlternatives(pattern: string): string[] {
  const alternatives: string[] = [];
  expandBraces(pattern, alternatives);
  return alternatives;
}

function expandBraces(pattern: string, into: string[]): void {
  // Nested groups multiply, so the walk stops at the cap instead of expanding them all.
  if (into.length >= MAX_BRACE_ALTERNATIVES) return;
  const open = pattern.indexOf('{');
  const close = open < 0 ? -1 : findMatchingBrace(pattern, open);
  const choices = close < 0 ? [] : splitTopLevelCommas(pattern.slice(open + 1, close));
  if (choices.length < 2) {
    into.push(pattern);
    return;
  }
  for (const choice of choices) {
    expandBraces(`${pattern.slice(0, open)}${choice}${pattern.slice(close + 1)}`, into);
  }
}

function findMatchingBrace(value: string, open: number): number {
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    if (value[index] === '{') depth += 1;
    if (value[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const character of value) {
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/**
 * Translates one brace-free segment into a regular expression body. `null` means the segment is
 * malformed and can name no entry, such as an unterminated character class.
 */
function translateSegment(segment: string): string | null {
  let body = '';
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if (character === '?' || character === '*') {
      body += character === '?' ? '[^/]' : '[^/]*';
      continue;
    }
    if (character === '[') {
      const characterClass = translateCharacterClass(segment, index);
      if (!characterClass) return null;
      body += characterClass.body;
      index = characterClass.end;
      continue;
    }
    body += escapeRegExp(character);
  }
  return body;
}

function translateCharacterClass(
  segment: string,
  start: number,
): { body: string; end: number } | null {
  let index = start + 1;
  const negated = segment[index] === '!' || segment[index] === '^';
  if (negated) index += 1;
  let body = '';
  let first = true;
  for (;;) {
    if (index >= segment.length) return null;
    const character = segment[index]!;
    if (character === ']' && !first) return { body: `[${negated ? '^' : ''}${body}]`, end: index };
    first = false;
    const following = segment[index + 1];
    const last = segment[index + 2];
    if (following === '-' && last !== undefined && last !== ']') {
      body += `${escapeRegExp(character)}-${escapeRegExp(last)}`;
      index += 3;
      continue;
    }
    body += escapeRegExp(character);
    index += 1;
  }
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
