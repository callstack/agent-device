import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
    'packages/daemon/src/sessions/handlers/fixture.ts':
      "import type { SessionState } from '../../core/session-state.ts';\n" +
      "import { SessionStore } from '../../core/session-store.ts';\n",
    'packages/daemon/src/sessions/handlers/request-only.ts':
      "import type { DaemonRequest } from '../../core/session-state.ts';\n" +
      "import { resolveDaemonStateDir } from '../../core/session-store.ts';\n",
    'packages/daemon/src/non-handler.ts':
      "import type { SessionState } from './core/session-state.ts';\n",
    'packages/daemon/src/sessions/handlers/fixture.test.ts':
      "import type { SessionState } from '../../core/session-state.ts';\n",
  };
  assert.deepEqual(overlayOf(sources), {
    shapeFiles: [
      'packages/daemon/src/non-handler.ts',
      'packages/daemon/src/sessions/handlers/fixture.ts',
    ],
    authorityFiles: ['packages/daemon/src/sessions/handlers/fixture.ts'],
  });
});

test('the overlay follows the SessionState declaration to a moved path, not a recorded one', () => {
  // Planted-red against a hardcoded src/daemon/types.ts target: #2346 moved the declaration to
  // session-state.ts, so importers point there, and the overlay must still count them.
  const sources = {
    'packages/daemon/src/types.ts': 'export type DaemonRequest = { x: number; };\n',
    'packages/daemon/src/core/session-state.ts': STATE_STUB,
    'packages/daemon/src/core/session-store.ts': STORE_STUB,
    'packages/daemon/src/sessions/handlers/fixture.ts':
      "import type { SessionState } from '../../core/session-state.ts';\n",
    'packages/daemon/src/non-handler.ts':
      "import type { SessionState } from './core/session-state.ts';\n",
  };
  assert.deepEqual(overlayOf(sources), {
    shapeFiles: [
      'packages/daemon/src/non-handler.ts',
      'packages/daemon/src/sessions/handlers/fixture.ts',
    ],
    authorityFiles: [],
  });
});

test('the handler-owned subset is the two live handler folders only', () => {
  const overlay: SessionAuthorityOverlay = {
    shapeFiles: [
      'packages/daemon/src/sessions/handlers/fixture.ts',
      'packages/daemon/src/execution/handlers/snapshot-handler.ts',
      'packages/daemon/src/handlers/legacy.ts',
      'packages/daemon/src/non-handler.ts',
      'packages/daemon/src/execution/interaction/internal/interaction.ts',
    ],
    authorityFiles: [
      'packages/daemon/src/sessions/handlers/fixture.ts',
      'packages/daemon/src/execution/handlers/snapshot-handler.ts',
      'packages/daemon/src/server/request-router.ts',
    ],
  };
  assert.deepEqual(handlerOwnedOverlay(overlay), {
    shapeFiles: [
      'packages/daemon/src/sessions/handlers/fixture.ts',
      'packages/daemon/src/execution/handlers/snapshot-handler.ts',
    ],
    authorityFiles: [
      'packages/daemon/src/sessions/handlers/fixture.ts',
      'packages/daemon/src/execution/handlers/snapshot-handler.ts',
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

test('the merge-base overlay arrives in head coordinates through the rename mapping', () => {
  // The merge-base tree declares SessionState under src/daemon/... and holds no layer folders.
  // mergeBaseRatchets canonicalizes every base path through renamedSince (the base's
  // src/daemon/handlers/*.ts pair with the head's layer-folder handlers/*.ts, and
  // session-store.ts pairs under core/), so the reference handler-owned set must already name
  // the live roots. This is what lets checkSessionAuthorityOverlay compare paths directly and
  // what makes the old flat handlers/ spellings in this rule dead weight.
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const reference = mergeBaseRatchets(repoRoot);
  const scoped = handlerOwnedOverlay(reference.sessionAuthority);
  assert.ok(scoped.shapeFiles.length > 0 && scoped.authorityFiles.length > 0);
  for (const file of [...scoped.shapeFiles, ...scoped.authorityFiles]) {
    assert.match(
      file,
      /^packages\/daemon\/src\/(?:sessions|execution)\/handlers\//,
      `merge-base handler member left the live roots: ${file}`,
    );
  }
  const baseSources = readCommittedSources(repoRoot, reference.ref).sources;
  assert.ok(
    [...baseSources.keys()].some((file) => file.startsWith('src/daemon/handlers/')),
    'the merge-base tree is expected to hold the pre-layer-folder src/daemon/handlers/ root',
  );
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
