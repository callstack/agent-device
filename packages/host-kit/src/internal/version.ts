import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentDeviceProjectRoot } from './project-root.ts';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';

const versionMemo = createTtlMemo<string, string>();
const projectRootMemo = createTtlMemo<'self', string>();

export function readVersion(root: string = findProjectRoot()): string {
  const memoized = versionMemo.get(root);
  if (memoized !== undefined) return memoized;

  let pkg: { version?: unknown };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
  } catch {
    return '0.0.0';
  }
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  versionMemo.set(root, version);
  return version;
}

export function findProjectRoot(): string {
  const memoized = projectRootMemo.get('self');
  if (memoized !== undefined) return memoized;
  const resolved = resolveAgentDeviceProjectRoot(path.dirname(fileURLToPath(import.meta.url)));
  projectRootMemo.set('self', resolved);
  return resolved;
}

/**
 * Whether `candidate` is a later release than `baseline` (see {@link compareVersions}).
 */
export function isNewerVersion(candidate: string, baseline: string): boolean {
  return compareVersions(candidate, baseline) > 0;
}

/**
 * SemVer order for the versions this package publishes: numeric `major.minor.patch` first, then a
 * release sorts after any prerelease of the same base (`0.21.13` > `0.21.13-dev`, the shape main
 * carries between releases), and prerelease fields compare per dot-separated field, numerically
 * when both are numbers and lexically otherwise. Build metadata is ignored. A string that is not a
 * version at all reads as `0.0.0`, so a malformed version always compares as the oldest.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  return compareRelease(a.release, b.release) || comparePrerelease(a.prerelease, b.prerelease);
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

type ParsedVersion = { release: [number, number, number]; prerelease: string[] };

function parseVersion(version: string): ParsedVersion {
  const match = SEMVER.exec(version.trim());
  if (!match) return { release: [0, 0, 0], prerelease: [] };
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareRelease(a: ParsedVersion['release'], b: ParsedVersion['release']): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! > b[i]! ? 1 : -1;
  }
  return 0;
}

/** A release (no prerelease) sorts after every prerelease of the same base. */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  if (b.length === 0) return -1;
  const fields = Math.max(a.length, b.length);
  for (let i = 0; i < fields; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = comparePrereleaseField(x, y);
    if (order !== 0) return order;
  }
  return 0;
}

/** Numeric fields compare as numbers and sort below alphanumeric ones; the rest compare lexically. */
function comparePrereleaseField(x: string, y: string): number {
  if (x === y) return 0;
  const xNumeric = /^\d+$/.test(x);
  const yNumeric = /^\d+$/.test(y);
  if (xNumeric && yNumeric) return Number(x) > Number(y) ? 1 : -1;
  if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
  return x > y ? 1 : -1;
}
