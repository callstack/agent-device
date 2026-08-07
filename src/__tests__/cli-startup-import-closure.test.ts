import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every CLI invocation eagerly evaluates the static import closure of
 * `src/cli.ts`. Importing `node:http` (or `node:https`) for a VALUE inside that
 * closure initializes undici and, under `NODE_USE_SYSTEM_CA=1`, the platform
 * trust store as well -- ~79ms added to every warm command on macOS, including
 * ones that never speak HTTP (the default daemon transport is a `node:net`
 * socket). The HTTP daemon transport, remote-artifact upload and download all
 * load these modules on demand instead.
 *
 * Type-only imports are free and stay allowed; this only rejects value imports.
 */

const srcRoot = path.resolve(import.meta.dirname, '..');
// `from './x.ts'` / `from "./x.ts"`, excluding `import type ... from`.
const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^;]*?)\s*from\s*['"]([^'"]+)['"]/g;

function collectStaticImports(source: string): { clause: string; specifier: string }[] {
  const found: { clause: string; specifier: string }[] = [];
  STATIC_IMPORT.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = STATIC_IMPORT.exec(source)) !== null) {
    found.push({ clause: match[1] ?? '', specifier: match[2] ?? '' });
  }
  return found;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  for (const suffix of ['.ts', '.tsx', '/index.ts']) {
    const withSuffix = `${candidate}${suffix}`;
    if (fs.existsSync(withSuffix)) return withSuffix;
  }
  return null;
}

function eagerClosureOfCli(): string[] {
  const queue = [path.join(srcRoot, 'cli.ts')];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const { specifier } of collectStaticImports(fs.readFileSync(current, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveRelative(current, specifier);
      if (resolved) queue.push(resolved);
    }
  }
  return [...visited];
}

test('the CLI startup import closure never value-imports node:http or node:https', () => {
  const offenders: string[] = [];
  for (const file of eagerClosureOfCli()) {
    for (const { clause, specifier } of collectStaticImports(fs.readFileSync(file, 'utf8'))) {
      if (specifier !== 'node:http' && specifier !== 'node:https') continue;
      // `import type http from` is caught by the regex's negative lookahead;
      // `import { type IncomingMessage } from` is a value import of nothing.
      const importsOnlyTypes = clause
        .replace(/^\{|\}$/g, '')
        .split(',')
        .every((binding) => binding.trim() === '' || binding.trim().startsWith('type '));
      if (importsOnlyTypes) continue;
      offenders.push(`${path.relative(srcRoot, file)} -> ${specifier}`);
    }
  }

  expect(
    offenders,
    'Load node:http / node:https on demand instead: a value import here costs every warm CLI ' +
      'command ~79ms of undici + system-CA initialization.',
  ).toEqual([]);
});

test('the CLI startup import closure is reachable and non-trivial', () => {
  // Guards the test above from silently passing because the walk found nothing.
  expect(eagerClosureOfCli().length).toBeGreaterThan(50);
});
