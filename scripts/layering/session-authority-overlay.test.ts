import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveImportEdges } from './model.ts';
import { mergeBaseRatchets } from './ratchet-reference.ts';
import { readCommittedSources } from '../__tests__/committed-source-tree.ts';
import {
  checkSessionAuthorityOverlay,
  handlerOwnedOverlay,
  measureSessionAuthorityOverlay,
  SESSION_AUTHORITY_OVERLAY_RULE,
  type SessionAuthorityOverlay,
} from './session-authority-overlay.ts';

const STATE_STUB =
  'export type SessionState = {\n  name: string;\n};\n' +
  'export type DaemonRequest = { x: number; };\n';
const STORE_STUB =
  'export class SessionStore { get(name: string) { return name; } }\n' +
  'export function resolveDaemonStateDir() { return "."; };\n';

function overlayOf(sources: Record<string, string>): SessionAuthorityOverlay {
  const tree = new Map(Object.entries(sources));
  return measureSessionAuthorityOverlay(tree, resolveImportEdges(tree));
}

test('the overlay counts symbol-level production importers, not file-level importers', () => {
  const sources = {
    'packages/daemon/src/core/session-state.ts': STATE_STUB,
    'packages/daemon/src/core/session-store.ts': STORE_STUB,
    'packages/daemon/src/sessions/handlers/subject.ts':
      "import type { SessionState } from '../../core/session-state.ts';\n" +
      "import { SessionStore } from '../../core/session-store.ts';\n",
    'packages/daemon/src/sessions/handlers/request-only.ts':
      "import type { DaemonRequest } from '../../core/session-state.ts';\n" +
      "import { resolveDaemonStateDir } from '../../core/session-store.ts';\n",
    'packages/daemon/src/non-handler.ts':
      "import type { SessionState } from './core/session-state.ts';\n",
    'packages/daemon/src/sessions/handlers/subject.test.ts':
      "import type { SessionState } from '../../core/session-state.ts';\n",
  };
  assert.deepEqual(overlayOf(sources), {
    shapeFiles: [
      'packages/daemon/src/non-handler.ts',
      'packages/daemon/src/sessions/handlers/subject.ts',
    ],
    authorityFiles: ['packages/daemon/src/sessions/handlers/subject.ts'],
  });
});

test('the overlay follows the SessionState declaration to a moved path, not a recorded one', () => {
  // Planted-red against a hardcoded src/daemon/types.ts target: #2346 moved the declaration to
  // session-state.ts, so importers point there, and the overlay must still count them.
  const sources = {
    'packages/daemon/src/types.ts': 'export type DaemonRequest = { x: number; };\n',
    'packages/daemon/src/core/session-state.ts': STATE_STUB,
    'packages/daemon/src/core/session-store.ts': STORE_STUB,
    'packages/daemon/src/sessions/handlers/subject.ts':
      "import type { SessionState } from '../../core/session-state.ts';\n",
    'packages/daemon/src/non-handler.ts':
      "import type { SessionState } from './core/session-state.ts';\n",
  };
  assert.deepEqual(overlayOf(sources), {
    shapeFiles: [
      'packages/daemon/src/non-handler.ts',
      'packages/daemon/src/sessions/handlers/subject.ts',
    ],
    authorityFiles: [],
  });
});

test('the handler-owned subset is every <layer>/handlers/ folder, not a recorded pair', () => {
  const overlay: SessionAuthorityOverlay = {
    shapeFiles: [
      'packages/daemon/src/sessions/handlers/subject.ts',
      'packages/daemon/src/execution/handlers/snapshot-handler.ts',
      // A handler folder under a layer the split never produced still joins the ratcheted
      // subset: membership comes from the folder shape, so no rule edit can miss it.
      'packages/daemon/src/core/handlers/newcomer.ts',
      'packages/daemon/src/handlers/legacy.ts',
      'packages/daemon/src/non-handler.ts',
      'packages/daemon/src/execution/interaction/internal/interaction.ts',
    ],
    authorityFiles: [
      'packages/daemon/src/sessions/handlers/subject.ts',
      'packages/daemon/src/execution/handlers/snapshot-handler.ts',
      'packages/daemon/src/core/handlers/newcomer.ts',
      'packages/daemon/src/server/request-router.ts',
    ],
  };
  assert.deepEqual(handlerOwnedOverlay(overlay), {
    shapeFiles: [
      'packages/daemon/src/sessions/handlers/subject.ts',
      'packages/daemon/src/execution/handlers/snapshot-handler.ts',
      'packages/daemon/src/core/handlers/newcomer.ts',
    ],
    authorityFiles: [
      'packages/daemon/src/sessions/handlers/subject.ts',
      'packages/daemon/src/execution/handlers/snapshot-handler.ts',
      'packages/daemon/src/core/handlers/newcomer.ts',
    ],
  });
});

test('R75 fails a handler file that gains a shape or authority edge beyond the merge-base', () => {
  const reference: SessionAuthorityOverlay = {
    shapeFiles: ['packages/daemon/src/sessions/handlers/kept.ts'],
    authorityFiles: ['packages/daemon/src/sessions/handlers/kept.ts'],
  };
  const measured: SessionAuthorityOverlay = {
    shapeFiles: [
      'packages/daemon/src/sessions/handlers/kept.ts',
      'packages/daemon/src/sessions/handlers/new-shape.ts',
    ],
    authorityFiles: ['packages/daemon/src/sessions/handlers/new-authority.ts'],
  };
  const violations = checkSessionAuthorityOverlay(measured, reference);
  assert.equal(violations.length, 2);
  const shape = violations.find(
    (violation) => violation.file === 'packages/daemon/src/sessions/handlers/new-shape.ts',
  )!;
  const authority = violations.find(
    (violation) => violation.file === 'packages/daemon/src/sessions/handlers/new-authority.ts',
  )!;
  assert.equal(shape.rule, SESSION_AUTHORITY_OVERLAY_RULE);
  assert.equal(authority.rule, SESSION_AUTHORITY_OVERLAY_RULE);
  assert.match(shape.message, /new handler-owned SessionState shape edge/);
  assert.match(authority.message, /new handler-owned SessionStore authority edge/);
  for (const { message } of [shape, authority]) {
    assert.match(message, /owning module's facade or a named semantic query/);
    assert.match(message, /change the invariant and the gate together/);
    assert.doesNotMatch(message, /accept the growth/);
  }
});

test('R75 passes when the handler-owned sets hold or shrink', () => {
  const reference: SessionAuthorityOverlay = {
    shapeFiles: [
      'packages/daemon/src/sessions/handlers/a.ts',
      'packages/daemon/src/sessions/handlers/b.ts',
    ],
    authorityFiles: ['packages/daemon/src/sessions/handlers/a.ts'],
  };
  const measured: SessionAuthorityOverlay = {
    shapeFiles: ['packages/daemon/src/sessions/handlers/a.ts'],
    authorityFiles: [],
  };
  assert.deepEqual(checkSessionAuthorityOverlay(measured, reference), []);
});

test('R75 leaves new non-handler importers to the module declarations, not this ratchet', () => {
  const measured: SessionAuthorityOverlay = {
    shapeFiles: ['packages/daemon/src/new-module.ts'],
    authorityFiles: ['packages/daemon/src/server/new-module.ts'],
  };
  assert.deepEqual(
    checkSessionAuthorityOverlay(measured, { shapeFiles: [], authorityFiles: [] }),
    [],
  );
});

test('the end-to-end measurement feeds the ratchet: a new handler importer is red, an existing one is not', () => {
  const base = {
    'packages/daemon/src/core/session-state.ts': STATE_STUB,
    'packages/daemon/src/core/session-store.ts': STORE_STUB,
    'packages/daemon/src/sessions/handlers/kept.ts':
      "import type { SessionState } from '../../core/session-state.ts';\n",
  };
  const reference = handlerOwnedOverlay(overlayOf(base));
  const grown = {
    ...base,
    'packages/daemon/src/sessions/handlers/new.ts':
      "import type { SessionState } from '../../core/session-state.ts';\n",
  };
  const measured = handlerOwnedOverlay(overlayOf(grown));
  assert.deepEqual(checkSessionAuthorityOverlay(reference, reference), []);
  const violations = checkSessionAuthorityOverlay(measured, reference);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.file, 'packages/daemon/src/sessions/handlers/new.ts');
});

test('the overlay classifies handler writes in both live handler roots, measured end to end', () => {
  // A write planted in each live layer folder must land in the ratcheted subset; the pre-fold
  // flat handlers/ spelling is dead in both trees (R10's retired-path guards own re-creation
  // there), so a write there stays out of scope even though the raw measurement sees it.
  const sources = {
    'packages/daemon/src/core/session-state.ts': STATE_STUB,
    'packages/daemon/src/core/session-store.ts': STORE_STUB,
    'packages/daemon/src/sessions/handlers/session-runtime.ts':
      "import { SessionStore } from '../../core/session-store.ts';\n",
    'packages/daemon/src/execution/handlers/snapshot-route.ts':
      "import type { SessionState } from '../../core/session-state.ts';\n",
    'packages/daemon/src/handlers/legacy.ts':
      "import type { SessionState } from '../core/session-state.ts';\n",
  };
  const measured = handlerOwnedOverlay(overlayOf(sources));
  assert.deepEqual(measured, {
    shapeFiles: ['packages/daemon/src/execution/handlers/snapshot-route.ts'],
    authorityFiles: ['packages/daemon/src/sessions/handlers/session-runtime.ts'],
  });
  // The raw overlay sees the stale spelling, so the exclusion above is the root filter's doing.
  assert.ok(overlayOf(sources).shapeFiles.includes('packages/daemon/src/handlers/legacy.ts'));
});

function commitAll(repo: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', message], { cwd: repo });
}

/**
 * A fixture repo whose base commit holds the pre-layer-folder daemon layout — a flat
 * `packages/daemon/src/handlers/` root, the SessionState declaration and the SessionStore
 * authority at the daemon root — and whose head commit is `git mv` into the layer folders.
 * Proves the RULE, not the real history: mergeBaseRatchets canonicalizes every base path
 * through renamedSince, so the handler-owned overlay arrives in head coordinates and no
 * base handler member is dropped from the scoped set. Reading the real merge-base could
 * only ever assert one repo state (this stack's, until main absorbs it), then rot.
 */
test('the merge-base overlay arrives in head coordinates through the rename mapping', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'session-authority-rename-'));
  const write = (file: string, text: string) => {
    const target = path.join(repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Gate'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'gate@example.test'], { cwd: repo });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
  write('packages/daemon/package.json', JSON.stringify({ name: '@agent-device/daemon' }));
  write('packages/daemon/src/session-state.ts', STATE_STUB);
  write('packages/daemon/src/session-store.ts', STORE_STUB);
  write(
    'packages/daemon/src/handlers/state-reader.ts',
    "import type { SessionState } from '../session-state.ts';\nexport const read = (s: SessionState) => s.name;\n",
  );
  write(
    'packages/daemon/src/handlers/store-user.ts',
    "import { SessionStore } from '../session-store.ts';\nexport const store = new SessionStore();\n",
  );
  write(
    'packages/daemon/src/session-snapshot.ts',
    "import type { SessionState } from './session-state.ts';\nexport const snap = (s: SessionState) => s.name;\n",
  );
  // Pad the files whose import specifiers the move rewrites: a one-line rewrite of a two-line
  // file is below git's rename-similarity threshold, and the fixture must pair the same
  // git-mv-plus-small-edit shape the daemon move actually has (cf. eager-closure-budgets).
  for (const file of ['session-state.ts', 'session-store.ts', 'session-snapshot.ts'])
    fs.appendFileSync(
      path.join(repo, 'packages/daemon/src', file),
      Array.from({ length: 40 }, (_, i) => `export const pad${i} = ${i};`).join('\n') + '\n',
    );
  for (const handler of ['handlers/state-reader.ts', 'handlers/store-user.ts'])
    fs.appendFileSync(
      path.join(repo, 'packages/daemon/src', handler),
      Array.from({ length: 40 }, (_, i) => `export const pad${i} = ${i};`).join('\n') + '\n',
    );
  commitAll(repo, 'base: flat daemon layout');
  for (const dir of [
    'packages/daemon/src/core',
    'packages/daemon/src/sessions/handlers',
    'packages/daemon/src/execution/handlers',
    'packages/daemon/src/execution',
  ])
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
  const baseRef = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  execFileSync(
    'git',
    ['mv', 'packages/daemon/src/session-state.ts', 'packages/daemon/src/core/session-state.ts'],
    { cwd: repo },
  );
  execFileSync(
    'git',
    ['mv', 'packages/daemon/src/session-store.ts', 'packages/daemon/src/core/session-store.ts'],
    { cwd: repo },
  );
  execFileSync(
    'git',
    [
      'mv',
      'packages/daemon/src/handlers/state-reader.ts',
      'packages/daemon/src/sessions/handlers/state-reader.ts',
    ],
    { cwd: repo },
  );
  execFileSync(
    'git',
    [
      'mv',
      'packages/daemon/src/handlers/store-user.ts',
      'packages/daemon/src/execution/handlers/store-user.ts',
    ],
    { cwd: repo },
  );
  execFileSync(
    'git',
    [
      'mv',
      'packages/daemon/src/session-snapshot.ts',
      'packages/daemon/src/execution/session-snapshot.ts',
    ],
    { cwd: repo },
  );
  for (const handler of ['sessions/handlers/state-reader.ts', 'execution/handlers/store-user.ts'])
    fs.appendFileSync(
      path.join(repo, 'packages/daemon/src', handler),
      '\nexport const touched = 1;\n',
    );
  commitAll(repo, 'head: layer folders');

  const reference = mergeBaseRatchets(repo, undefined, baseRef);
  assert.ok(
    [...readCommittedSources(repo, baseRef).sources.keys()].some((file) =>
      file.startsWith('packages/daemon/src/handlers/'),
    ),
    'the fixture base tree is expected to hold the pre-rename flat handlers/ root',
  );
  // Every base handler member survives the canonicalization: one shape edge under
  // sessions/handlers/, one authority edge under execution/handlers/. A reference that
  // silently lost them (an unpaired rename) would accept any future handler growth.
  const scoped = handlerOwnedOverlay(reference.sessionAuthority);
  assert.deepEqual(scoped.shapeFiles, ['packages/daemon/src/sessions/handlers/state-reader.ts']);
  assert.deepEqual(scoped.authorityFiles, ['packages/daemon/src/execution/handlers/store-user.ts']);
  for (const file of [...scoped.shapeFiles, ...scoped.authorityFiles]) {
    assert.match(
      file,
      /^packages\/daemon\/src\/(?:sessions|execution)\/handlers\//,
      `merge-base handler member left the live roots: ${file}`,
    );
  }
  // The non-handler base importer keeps its full-scope membership and stays out of the
  // handler-owned subset — canonicalization moved it, the scope filter kept it out.
  assert.ok(
    reference.sessionAuthority.shapeFiles.includes(
      'packages/daemon/src/execution/session-snapshot.ts',
    ),
  );
  assert.ok(!scoped.shapeFiles.includes('packages/daemon/src/execution/session-snapshot.ts'));
});

test('R75 catches a new handler shape edge expressed as an import type', () => {
  const base = {
    'packages/daemon/src/core/session-state.ts': STATE_STUB,
    'packages/daemon/src/core/session-store.ts': STORE_STUB,
  };
  const reference = handlerOwnedOverlay(overlayOf(base));
  const measured = handlerOwnedOverlay(
    overlayOf({
      ...base,
      'packages/daemon/src/sessions/handlers/new.ts':
        "type State = import('../../core/session-state.ts').SessionState;\n",
    }),
  );

  const violations = checkSessionAuthorityOverlay(measured, reference);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, SESSION_AUTHORITY_OVERLAY_RULE);
  assert.equal(violations[0]!.file, 'packages/daemon/src/sessions/handlers/new.ts');
  assert.match(violations[0]!.message, /new handler-owned SessionState shape edge/);
});
