import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentDeviceProjectRoot } from './project-root.ts';
import { createTtlMemo } from './ttl-memo.ts';

// Immutable for a process's lifetime, so resolved once; the process-memo reset clears them between tests.
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
  const resolved = resolveAgentDeviceProjectRoot(path.dirname(fileURLToPath(import.meta.url)));
  projectRootMemo.set('self', resolved);
  return resolved;
}
