// Façade export enumeration, tested directly: what `readNamedExports` and
// `readFacadeExports` report for each export FORM, independently of the R11
// boundary rules that consume them.
//
// The `readFacadeExports` cases write throwaway modules under a real package
// rather than using committed fixtures — a fixture would pin the walker
// against a file shape this repo never actually ships.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readFacadeExports, readNamedExports } from './facade-exports.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('readNamedExports collects re-export and direct-declaration forms, resolving aliases', () => {
  const source = [
    "export { a, b } from './x.ts';",
    "export type { C, D } from './y.ts';",
    "export { e as f } from './z.ts';",
    "export type { g as h } from './z.ts';",
    'export function i() {}',
    'export const j = 1;',
    'export type K = string;',
    'export interface L {}',
    "export {\n  m,\n  n,\n} from './multi.ts';",
  ].join('\n');
  assert.deepEqual(
    readNamedExports(source),
    ['D', 'C', 'K', 'L', 'a', 'b', 'f', 'h', 'i', 'j', 'm', 'n'].sort(),
  );
});

test('readNamedExports never reports the original name behind an `as` alias', () => {
  const source = "export { internalOnly as publicName } from './x.ts';";
  const names = readNamedExports(source);
  assert.deepEqual(names, ['publicName']);
  assert.ok(!names.includes('internalOnly'));
});

test('readNamedExports resolves `export * as ns` to its one real bound name', () => {
  // Unlike bare `export *`, this binds exactly one importable name (`ns`) —
  // enumerable, not a widening blind spot.
  const source = "export * as ns from './x.ts';";
  assert.deepEqual(readNamedExports(source), ['ns']);
});

// #1555 review P1 (second pass, "the gate also ignores export-star
// declarations, so it can miss future widening"): a facade pinned to an
// exact named-export list must not silently accept a form that widens its
// real surface with no enumerable name at all. These two forms throw instead
// of contributing nothing to the list — plant-verified (temporarily reverted
// to a no-op, confirmed both tests failed, restored) rather than merely
// asserted.
test('readNamedExports rejects a bare `export *` re-export', () => {
  const source = "export { runAdReplay } from './step-loop.ts';\nexport * from './leak.ts';\n";
  assert.throws(() => readNamedExports(source), /export \* from/);
});

test('readNamedExports rejects a default export', () => {
  assert.throws(() => readNamedExports('export default function leak() {}'), /export default/);
  assert.throws(() => readNamedExports('export default 42;'), /export default/);
});

test('readNamedExports reports `export { default as x }` as the named symbol x', () => {
  // The one form that sits between the two rejection rules above: the LOCAL
  // name is `default`, but what it binds in this module — and the only thing
  // a consumer can import — is `x`. Enumerable, so it must be reported, not
  // thrown; and `default` must never appear in the list.
  const names = readNamedExports("export { default as x, b } from './y.ts';");
  assert.deepEqual(names, ['b', 'x']);
  assert.ok(!names.includes('default'));
});

test('readNamedExports collects a local `export { … }` list with no `from`', () => {
  // The re-export tests above all carry a `from`; a façade that declares
  // first and exports at the bottom is the same public surface.
  assert.deepEqual(
    readNamedExports('const a = 1;\ntype T = string;\nexport { a };\nexport type { T };'),
    ['T', 'a'],
  );
});

test('readNamedExports collects every declarator of a multi-declarator export', () => {
  // Documented in the helper's contract; the direct-declaration test above
  // only exercises a single declarator, so the second name went unpinned.
  assert.deepEqual(readNamedExports('export const a = 1, b = 2;'), ['a', 'b']);
});

// `readFacadeExports` is the same enumeration widened from one source string
// to the re-export CHAIN behind a file — the form every `contracts` façade
// is built from. These use the real tree's own barrels rather than fixtures:
// a fixture would pin the walker against a file this repo never ships.
test('readFacadeExports resolves a bare `export *` chain the source-only reader refuses', () => {
  const barrel = path.join(repoRoot, 'packages/contracts/src/facades/session.ts');
  // Source-only: unknowable, so it throws (the merged contract, unchanged).
  assert.throws(() => readNamedExports(fs.readFileSync(barrel, 'utf8')), /export \* from/);
  // Given the FILE, the same barrel is fully enumerable.
  assert.deepEqual(readFacadeExports(barrel), [
    'SESSION_SURFACES',
    'SessionAction',
    'SessionSurface',
    'parseSessionSurface',
  ]);
});

test('readFacadeExports refuses a bare `export *` across a package specifier', () => {
  // A relative star names a module this gate can read; a package star means
  // resolving node_modules into another package's exports map — unbounded
  // widening, the exact thing the gate refuses.
  const scratch = path.join(repoRoot, 'packages/contracts/src/facades/.export-star-probe.ts');
  fs.writeFileSync(scratch, "export * from '@agent-device/kernel/errors';\n");
  try {
    assert.throws(() => readFacadeExports(scratch), /only a relative re-export/);
  } finally {
    fs.rmSync(scratch);
  }
});

/** Write throwaway modules next to a real façade; always clean them up. */
function withProbeModules(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = path.join(repoRoot, 'packages/contracts/src/facades');
  const written = Object.entries(files).map(([name, source]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return file;
  });
  try {
    run(dir);
  } finally {
    for (const file of written) fs.rmSync(file, { force: true });
  }
}

test('readFacadeExports excludes a default that a star export cannot reach', () => {
  // #1574 review P1: `export *` skips the child's default per
  // GetExportedNames, so a private default in a leaf is NOT part of the
  // barrel's surface. Counterfactual: the named sibling still comes through,
  // proving the leaf is genuinely being read and the default specifically —
  // not the whole module — is what got dropped.
  withProbeModules(
    {
      '.leaf-probe.ts': 'export default function hidden() {}\nexport const reachable = 1;\n',
      '.barrel-probe.ts': "export * from './.leaf-probe.ts';\n",
    },
    (dir) => {
      assert.deepEqual(readFacadeExports(path.join(dir, '.barrel-probe.ts')), ['reachable']);
    },
  );
});

test('readFacadeExports still rejects a default on the façade entry itself', () => {
  // The other side of the same rule: the entry's own default IS a default
  // export of the façade, and a façade pinned to a named list must not carry
  // one. Same source text as the leaf above — only its position changed.
  withProbeModules({ '.entry-default-probe.ts': 'export default function leak() {}\n' }, (dir) => {
    assert.throws(
      () => readFacadeExports(path.join(dir, '.entry-default-probe.ts')),
      /export default/,
    );
  });
});

test('readFacadeExports rejects a name two star sources resolve differently', () => {
  // ESM resolves this to `ambiguous`, so `clash` is not importable at all;
  // unioning would pin a symbol no consumer can reach.
  withProbeModules(
    {
      '.clash-a-probe.ts': 'export const clash = 1;\nexport const onlyA = 1;\n',
      '.clash-b-probe.ts': 'export const clash = 2;\n',
      '.clash-barrel-probe.ts':
        "export * from './.clash-a-probe.ts';\nexport * from './.clash-b-probe.ts';\n",
    },
    (dir) => {
      assert.throws(() => readFacadeExports(path.join(dir, '.clash-barrel-probe.ts')), /ambiguous/);
    },
  );
});

test('readFacadeExports resolves a diamond and lets an explicit export shadow a star', () => {
  // The two counterfactuals to the ambiguity rule, both of which a naive
  // "two paths reached this name" check would wrongly reject. One shared
  // declaration reached by two barrels is ONE binding, not a clash; and an
  // explicit re-export of a name a star also provides is the spec's own
  // precedence, not ambiguity.
  withProbeModules(
    {
      '.shared-probe.ts': 'export const shared = 1;\n',
      '.mid-one-probe.ts': "export * from './.shared-probe.ts';\n",
      '.mid-two-probe.ts': "export * from './.shared-probe.ts';\n",
      '.diamond-probe.ts':
        "export * from './.mid-one-probe.ts';\nexport * from './.mid-two-probe.ts';\n",
      '.shadow-src-probe.ts': 'export const shadowed = 1;\nexport const other = 2;\n',
      '.shadow-probe.ts':
        "export * from './.shadow-src-probe.ts';\nexport { shadowed } from './.shared-probe.ts';\n",
    },
    (dir) => {
      assert.deepEqual(readFacadeExports(path.join(dir, '.diamond-probe.ts')), ['shared']);
      assert.deepEqual(readFacadeExports(path.join(dir, '.shadow-probe.ts')), [
        'other',
        'shadowed',
      ]);
    },
  );
});

test('readFacadeExports follows a named re-export chain to its ultimate binding', () => {
  // #1574 review P1: `a` re-exports `x` from `b`, `c` re-exports `x` from
  // `a`, and the façade stars both. ESM resolves ONE binding (`b`'s `x`), so
  // this is a diamond, not a clash. Identifying a re-export by its immediate
  // source would see `b#x` vs `a#x` and falsely reject the façade — the
  // counterfactual that fails without transitive origin resolution.
  withProbeModules(
    {
      '.chain-b-probe.ts': 'export const x = 1;\n',
      '.chain-a-probe.ts': "export { x } from './.chain-b-probe.ts';\n",
      '.chain-c-probe.ts': "export { x } from './.chain-a-probe.ts';\n",
      '.chain-facade-probe.ts':
        "export * from './.chain-a-probe.ts';\nexport * from './.chain-c-probe.ts';\n",
    },
    (dir) => {
      assert.deepEqual(readFacadeExports(path.join(dir, '.chain-facade-probe.ts')), ['x']);
    },
  );
});

test('readFacadeExports keeps rejecting two genuinely distinct bindings behind a chain', () => {
  // The guard against over-correcting the above: resolving through chains
  // must not collapse two REAL declarations into one. Same chain depth as the
  // diamond, but the two branches bottom out in different modules.
  withProbeModules(
    {
      '.split-one-probe.ts': 'export const y = 1;\n',
      '.split-two-probe.ts': 'export const y = 2;\n',
      '.split-a-probe.ts': "export { y } from './.split-one-probe.ts';\n",
      '.split-c-probe.ts': "export { y } from './.split-two-probe.ts';\n",
      '.split-facade-probe.ts':
        "export * from './.split-a-probe.ts';\nexport * from './.split-c-probe.ts';\n",
    },
    (dir) => {
      assert.throws(() => readFacadeExports(path.join(dir, '.split-facade-probe.ts')), /ambiguous/);
    },
  );
});

// #1574 review, third round. `export { default } from './x.ts'` is reported
// by oxc as kind `Name` with the name `default` — the same fact as
// `export default …` wearing a different parse shape. It has to stay in a
// module's map so a later `export { default as x }` can resolve its binding,
// while never being reachable through a star. These three pin that split.
test('a star export does not re-export a name called `default`', () => {
  // Per GetExportedNames a star skips `default` — oxc names the star's own
  // import `AllButDefault`. Counterfactual: the ordinary sibling name in the
  // same module still comes through, so this is `default` being filtered and
  // not the whole module being dropped.
  withProbeModules(
    {
      '.dstar-leaf-probe.ts': 'export default function hidden() {}\nexport const kept = 1;\n',
      '.dstar-mid-probe.ts':
        "export { default } from './.dstar-leaf-probe.ts';\n" +
        "export { kept } from './.dstar-leaf-probe.ts';\n",
      '.dstar-facade-probe.ts': "export * from './.dstar-mid-probe.ts';\n",
    },
    (dir) => {
      assert.deepEqual(readFacadeExports(path.join(dir, '.dstar-facade-probe.ts')), ['kept']);
    },
  );
});

test('a façade re-exporting a default under the name `default` is rejected', () => {
  // The entry carries a default export either way; only the parse shape
  // differs from the `export default …` case above.
  withProbeModules(
    {
      '.dentry-leaf-probe.ts': 'export default function leak() {}\n',
      '.dentry-facade-probe.ts': "export { default } from './.dentry-leaf-probe.ts';\n",
    },
    (dir) => {
      assert.throws(
        () => readFacadeExports(path.join(dir, '.dentry-facade-probe.ts')),
        /must not carry one/,
      );
    },
  );
});

test('two paths to one default binding resolve to a single name, not ambiguity', () => {
  // `leaf` declares a default; `a` re-exports it; `b` names a's default `x`
  // while `c` names leaf's default `x`; a façade stars both. ESM resolves ONE
  // `leaf#default` binding, so `x` is exported rather than ambiguous — the
  // intermediate `export { default } from` link has to carry identity through
  // for the two paths to agree.
  withProbeModules(
    {
      '.dchain-leaf-probe.ts': 'export default function shared() {}\n',
      '.dchain-a-probe.ts': "export { default } from './.dchain-leaf-probe.ts';\n",
      '.dchain-b-probe.ts': "export { default as x } from './.dchain-a-probe.ts';\n",
      '.dchain-c-probe.ts': "export { default as x } from './.dchain-leaf-probe.ts';\n",
      '.dchain-facade-probe.ts':
        "export * from './.dchain-b-probe.ts';\nexport * from './.dchain-c-probe.ts';\n",
    },
    (dir) => {
      assert.deepEqual(readFacadeExports(path.join(dir, '.dchain-facade-probe.ts')), ['x']);
    },
  );
});
