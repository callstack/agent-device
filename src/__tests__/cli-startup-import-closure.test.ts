import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eagerClosureOf, eagerlyEvaluatedModules } from './eager-import-closure.fixtures.ts';

/**
 * Every CLI invocation eagerly evaluates the static import closure of
 * `src/cli.ts`. Importing `node:http` (or `node:https`) for a VALUE inside that
 * closure initializes undici and, under `NODE_USE_SYSTEM_CA=1`, the platform
 * trust store as well -- ~79ms added to every warm command on macOS, including
 * ones that never speak HTTP (the default daemon transport is a `node:net`
 * socket). The HTTP daemon transport, remote-artifact upload and download all
 * load these modules on demand instead.
 *
 * `@agent-device/maestro` is held to the same line for the same reason. The command registry
 * evaluates every command family's module on startup -- `--help` included -- so a replay-side
 * static import of the Maestro engine (and the YAML parser behind it) put a 131 kB chunk and
 * ~28ms on every warm command, for a format most invocations never touch (#1802). The replay
 * script-source builder loads it on demand, only once an entry actually resolves to a flow.
 */

const srcRoot = path.resolve(import.meta.dirname, '..');
const LAZY_HTTP_MODULES = new Set(['node:http', 'node:https']);
/** Engines heavy enough that evaluating them on startup is a measurable regression. */
const LAZY_ENGINE_MODULES = new Set(['@agent-device/maestro']);

test.for([
  // --- static forms ---
  { form: 'side-effect import', code: `import 'node:http';`, eager: true },
  { form: 'default value import', code: `import http from 'node:http';`, eager: true },
  { form: 'namespace import', code: `import * as http from 'node:http';`, eager: true },
  { form: 'named value import', code: `import { request } from 'node:http';`, eager: true },
  { form: 'value re-export', code: `export { request } from 'node:http';`, eager: true },
  { form: 'star re-export', code: `export * from 'node:http';`, eager: true },
  {
    form: 'mixed value + type import',
    code: `import http, { type IncomingMessage } from 'node:http';`,
    eager: true,
  },
  { form: 'type-only default import', code: `import type http from 'node:http';`, eager: false },
  {
    form: 'type-only named import',
    code: `import { type IncomingMessage } from 'node:http';`,
    eager: false,
  },
  {
    form: 'type-only re-export',
    code: `export type { IncomingMessage } from 'node:http';`,
    eager: false,
  },
  // --- dynamic import: scope decides, not syntax ---
  { form: 'top-level await import', code: `const m = await import('node:http');`, eager: true },
  { form: 'top-level import().then', code: `import('node:http').then((m) => m);`, eager: true },
  {
    form: 'top-level immediately-invoked arrow',
    code: `(async () => { await import('node:http'); })();`,
    eager: true,
  },
  {
    form: 'function-declaration-local import',
    code: `async function load() { return await import('node:http'); }`,
    eager: false,
  },
  {
    form: 'arrow-local import',
    code: `const load = async () => await import('node:http');`,
    eager: false,
  },
  {
    form: 'method-local import',
    code: `class K { async load() { await import('node:http'); } }`,
    eager: false,
  },
  {
    form: 'ternary inside a function (the shipped lazy-load shape)',
    code: `async function load(s: boolean) {
      return s ? (await import('node:https')).default : (await import('node:http')).default;
    }`,
    eager: false,
  },
])('$form is eager=$eager', ({ code, eager }) => {
  const refs = eagerlyEvaluatedModules('fixture.ts', code);
  expect(refs.includes('node:http') || refs.includes('node:https')).toBe(eager);
});

test('the CLI startup import closure never evaluates node:http or node:https', () => {
  const offenders: string[] = [];
  for (const file of eagerClosureOf(path.join(srcRoot, 'cli.ts'))) {
    for (const specifier of eagerlyEvaluatedModules(file, fs.readFileSync(file, 'utf8'))) {
      if (LAZY_HTTP_MODULES.has(specifier)) {
        offenders.push(`${path.relative(srcRoot, file)} -> ${specifier}`);
      }
    }
  }

  expect(
    offenders,
    'Load node:http / node:https on demand instead: evaluating either one here costs every warm ' +
      'CLI command ~79ms of undici + system-CA initialization.',
  ).toEqual([]);
});

test('the CLI startup import closure never evaluates the Maestro engine', () => {
  const offenders: string[] = [];
  for (const file of eagerClosureOf(path.join(srcRoot, 'cli.ts'))) {
    for (const specifier of eagerlyEvaluatedModules(file, fs.readFileSync(file, 'utf8'))) {
      if (LAZY_ENGINE_MODULES.has(specifier)) {
        offenders.push(`${path.relative(srcRoot, file)} -> ${specifier}`);
      }
    }
  }

  expect(
    offenders,
    'Load @agent-device/maestro on demand instead: the command registry evaluates every command ' +
      'family on startup, so importing the engine here costs every warm CLI command ~28ms of ' +
      'YAML-parser evaluation and a 131 kB startup chunk, for a format most runs never use.',
  ).toEqual([]);
});

test('the CLI startup import closure is reachable and crosses the package boundary', () => {
  // Guards the test above from silently passing because the walk found nothing:
  // a resolver that returned null for everything would leave both the src side
  // and the workspace side of the closure empty while the guard stayed green.
  const closure = eagerClosureOf(path.join(srcRoot, 'cli.ts'));
  expect(closure.length).toBeGreaterThan(50);
  expect(
    closure.filter((file) => file.includes(`${path.sep}packages${path.sep}`)).length,
  ).toBeGreaterThan(0);
});
