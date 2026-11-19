import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UNIQUE_EXPORTED_TYPE_NAMES_RULE,
  uniqueExportedTypeNamesViolations,
  type SpecifierTargets,
} from './unique-exported-type-names.ts';

function violationsOf(
  sources: readonly { path: string; source: string }[],
  specifierTargets: SpecifierTargets = new Map(),
) {
  return uniqueExportedTypeNamesViolations(sources, specifierTargets);
}

function messagesOf(
  sources: readonly { path: string; source: string }[],
  specifierTargets: SpecifierTargets = new Map(),
): string[] {
  return violationsOf(sources, specifierTargets).map((violation) => violation.message);
}

test('two declarations of one type name in one package are a collision', () => {
  const violations = violationsOf([
    { path: 'packages/contracts/src/a.ts', source: 'export type PointTarget = { x: number };\n' },
    { path: 'packages/contracts/src/b.ts', source: 'export type PointTarget = { y: number };\n' },
  ]);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((violation) => violation.rule === UNIQUE_EXPORTED_TYPE_NAMES_RULE));
  assert.match(
    violations[0]!.message,
    /'PointTarget' is exported from 2 different modules of packages\/contracts/,
  );
  assert.deepEqual(violations.map((violation) => violation.file).sort(), [
    'packages/contracts/src/a.ts',
    'packages/contracts/src/b.ts',
  ]);
});

test('the same name in two different packages is legal (cross-package alias)', () => {
  assert.deepEqual(
    messagesOf([
      { path: 'packages/contracts/src/a.ts', source: 'export type Target = { x: number };\n' },
      { path: 'packages/daemon/src/b.ts', source: 'export type Target = { y: number };\n' },
      { path: 'src/c.ts', source: 'export type Target = { z: number };\n' },
    ]),
    [],
  );
});

test('a barrel re-exporting one declaration is the same symbol, not a collision', () => {
  assert.deepEqual(
    messagesOf([
      {
        path: 'packages/contracts/src/target.ts',
        source: 'export type PointTarget = { x: number };\n',
      },
      {
        path: 'packages/contracts/src/index.ts',
        source: "export type { PointTarget } from './target.ts';\n",
      },
      {
        path: 'packages/contracts/src/local.ts',
        source: "import type { PointTarget } from './target.ts';\nexport type { PointTarget };\n",
      },
    ]),
    [],
  );
});

test('a declaration plus a re-export of a different module in the same package collide', () => {
  const messages = messagesOf([
    { path: 'packages/contracts/src/public.ts', source: 'export type Target = { x: number };\n' },
    {
      path: 'packages/contracts/src/internal.ts',
      source: 'export type Target = { kind: string };\n',
    },
    {
      path: 'packages/contracts/src/index.ts',
      source: "export type { Target } from './internal.ts';\n",
    },
  ]);
  assert.equal(messages.length, 2);
  assert.match(messages[0]!, /'Target' is exported from 2 different modules/);
});

test("re-exporting another package's type under the same name stays legal at the seam", () => {
  const targets: SpecifierTargets = new Map([
    ['@agent-device/kernel/thing', 'packages/kernel/src/thing.ts'],
  ]);
  assert.deepEqual(
    messagesOf(
      [
        {
          path: 'packages/kernel/src/thing.ts',
          source: 'export type Shared = { x: number };\n',
        },
        {
          path: 'packages/selectors/src/internal/predicates.ts',
          source: "export type { Shared } from '@agent-device/kernel/thing';\n",
        },
        {
          path: 'packages/selectors/src/index.ts',
          source: "export type { Shared } from './internal/predicates.ts';\n",
        },
      ],
      targets,
    ),
    [],
  );
});

test('a type-kind entry per specifier and star re-exports resolve through the target', () => {
  const messages = messagesOf([
    {
      path: 'packages/a/src/one.ts',
      source: 'export interface Opts { depth?: number }\n',
    },
    {
      path: 'packages/a/src/two.ts',
      source: 'export interface Opts { raw?: boolean }\n',
    },
    {
      path: 'packages/a/src/star.ts',
      source: "export type * from './one.ts';\nexport * from './two.ts';\n",
    },
    {
      path: 'packages/a/src/mixed.ts',
      source: "export { type Opts } from './one.ts';\n",
    },
  ]);
  // one.ts and two.ts both declare Opts in packages/a; the star file and the mixed file
  // re-export each, so the package-level name has two origins.
  assert.ok(messages.length >= 2);
  assert.match(messages[0]!, /'Opts' is exported from 2 different modules of packages\/a/);
});

test('explicit exports shadow star re-exports instead of colliding with them', () => {
  // packages/b's Opts arrives through the star; the explicit export from ./one.ts wins, so
  // package a's Opts has a single origin and the cross-package star adds no collision.
  assert.deepEqual(
    messagesOf([
      {
        path: 'packages/a/src/one.ts',
        source: 'export type Opts = { a: number };\n',
      },
      {
        path: 'packages/b/src/two.ts',
        source: 'export type Opts = { b: number };\n',
      },
      {
        path: 'packages/a/src/index.ts',
        source: "export type { Opts } from './one.ts';\nexport * from '../../b/src/two.ts';\n",
      },
    ]),
    [],
  );
});

test('value re-exports of plain functions are not type names', () => {
  assert.deepEqual(
    messagesOf([
      {
        path: 'packages/a/src/fn.ts',
        source: 'export function run(): void {}\n',
      },
      {
        path: 'packages/a/src/index.ts',
        source: "export { run } from './fn.ts';\n",
      },
      {
        path: 'packages/a/src/other.ts',
        source: "import { run } from './fn.ts';\nexport { run };\n",
      },
    ]),
    [],
  );
});

test('interfaces, enums and classes occupy the type namespace too', () => {
  assert.match(
    messagesOf([
      { path: 'packages/a/src/one.ts', source: 'export interface Shape { a: number }\n' },
      { path: 'packages/a/src/two.ts', source: 'export class Shape { b = 1 }\n' },
    ])[0]!,
    /'Shape' is exported from 2 different modules/,
  );
  assert.match(
    messagesOf([
      { path: 'packages/a/src/one.ts', source: 'export enum Mode { A }\n' },
      { path: 'packages/a/src/two.ts', source: 'export type Mode = "a";\n' },
    ])[0]!,
    /'Mode' is exported from 2 different modules/,
  );
});

test('locally declared then exported types count as declared here', () => {
  assert.deepEqual(
    messagesOf([
      {
        path: 'packages/a/src/one.ts',
        source: 'type Hidden = { a: number };\nexport type { Hidden };\n',
      },
      {
        path: 'packages/a/src/index.ts',
        source: "export type { Hidden } from './one.ts';\n",
      },
    ]),
    [],
  );
  assert.match(
    messagesOf([
      {
        path: 'packages/a/src/one.ts',
        source: 'type Hidden = { a: number };\nexport type { Hidden };\n',
      },
      { path: 'packages/a/src/two.ts', source: 'export type Hidden = { b: number };\n' },
    ])[0]!,
    /'Hidden' is exported from 2 different modules/,
  );
});
