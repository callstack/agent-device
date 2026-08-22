import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTtlMemo } from './ttl-memo.ts';

// A running process cannot observe its own package version or its own project
// root changing, and both are read several times per CLI invocation (daemon
// reuse check, transport client version, help header, runner cache key), so
// each is resolved once and cleared between tests by the process-memo reset.
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
    // An absent or unreadable package.json is not memoized: the caller may be
    // asking about a root that is still being materialized (a runner or helper
    // package), and '0.0.0' must not stick to it for the rest of the process.
    return '0.0.0';
  }
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  versionMemo.set(root, version);
  return version;
}

export function findProjectRoot(): string {
  const memoized = projectRootMemo.get('self');
  if (memoized !== undefined) return memoized;

  const start = path.dirname(fileURLToPath(import.meta.url));
  let current = start;
  for (let i = 0; i < 6; i += 1) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      projectRootMemo.set('self', current);
      return current;
    }
    current = path.dirname(current);
  }
  return start;
}
