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
