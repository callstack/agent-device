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
 * Whether `candidate` is a later release than `baseline` under SemVer ordering: numeric
 * `major.minor.patch` first, then a release sorts after any prerelease of the same base
 * (`0.21.13` > `0.21.13-dev`), and prerelease identifiers compare per dot-separated field,
 * numerically when both are numbers and lexically otherwise. Build metadata is ignored. The daemon
 * takeover decision needs exactly this to tell an upgrade from a downgrade across the `-dev`
 * versions main carries between releases.
 */
export function isNewerVersion(candidate: string, baseline: string): boolean {
  return compareVersions(candidate, baseline) > 0;
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i += 1) {
    const x = a.release[i] ?? 0;
    const y = b.release[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const fields = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < fields; i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) > Number(y) ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function parseVersion(version: string): { release: number[]; prerelease: string[] } {
  const [core = '', prerelease = ''] = version.split('+', 1)[0]!.split(/-(.*)/s, 2);
  const release = core.split('.').map((part) => Number.parseInt(part, 10));
  while (release.length < 3) release.push(0);
  return {
    release: release.map((part) => (Number.isNaN(part) ? 0 : part)),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}
