import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from '../utils/version.ts';

// Any quoted, relative-path-shaped string literal is treated as a module
// specifier, rather than matching the `import`/`export`/`from` grammar
// around it: bundlers only ever emit relative string literals for real
// specifiers, but the surrounding syntax varies too much to track reliably —
// formatted source spaces `import { x } from './y'` out, a minified build
// (tsdown/rolldown `minify: true`) squashes it to `import{x}from"./y"`, and a
// keyword-anchored regex tuned for one silently stops matching the other
// (#1545: the daemon's own built entry fingerprinted to just itself, since
// nothing downstream of it ever matched). A literal that isn't really an
// import (e.g. one that shows up inside a comment) simply fails to resolve
// to a file below and gets dropped, so over-matching here is harmless.
const RELATIVE_SPECIFIER_RE = /(['"])(\.\.?\/[^'"]*)\1/g;
const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

export function resolveDaemonCodeSignature(): string {
  const entryPath = process.argv[1];
  if (!entryPath) return 'unknown';
  return computeDaemonCodeSignature(entryPath);
}

export function computeDaemonCodeSignature(
  entryPath: string,
  root: string = findProjectRoot(),
): string {
  try {
    const normalizedRoot = path.resolve(root);
    const normalizedEntryPath = path.resolve(entryPath);
    const queue = [normalizedEntryPath];
    const visited = new Set<string>();
    const fingerprintParts: string[] = [];

    while (queue.length > 0) {
      const currentPath = queue.pop();
      if (!currentPath || visited.has(currentPath)) continue;
      visited.add(currentPath);

      const stat = fs.statSync(currentPath);
      if (!stat.isFile()) continue;

      const relativePath = path.relative(normalizedRoot, currentPath) || currentPath;
      fingerprintParts.push(`${relativePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);

      const content = fs.readFileSync(currentPath, 'utf8');
      for (const specifier of collectRelativeImportSpecifiers(content)) {
        const dependencyPath = resolveRelativeImportPath(currentPath, specifier);
        if (dependencyPath) {
          queue.push(dependencyPath);
        }
      }
    }

    const fingerprint = fingerprintParts.sort().join('|');
    const hash = crypto.createHash('sha1').update(fingerprint).digest('hex');
    return `graph:${fingerprintParts.length}:${hash}`;
  } catch {
    return 'unknown';
  }
}

function collectRelativeImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  RELATIVE_SPECIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = RELATIVE_SPECIFIER_RE.exec(content)) !== null) {
    specifiers.add(match[2]!);
  }
  return [...specifiers];
}

function resolveRelativeImportPath(fromPath: string, specifier: string): string | null {
  const basePath = path.resolve(path.dirname(fromPath), specifier);
  const direct = resolveExistingFile(basePath);
  if (direct) return direct;

  for (const extension of RESOLVABLE_EXTENSIONS) {
    const withExtension = resolveExistingFile(`${basePath}${extension}`);
    if (withExtension) return withExtension;
  }

  for (const extension of RESOLVABLE_EXTENSIONS) {
    const indexPath = resolveExistingFile(path.join(basePath, `index${extension}`));
    if (indexPath) return indexPath;
  }

  return null;
}

function resolveExistingFile(candidatePath: string): string | null {
  try {
    return fs.statSync(candidatePath).isFile() ? candidatePath : null;
  } catch {
    return null;
  }
}
