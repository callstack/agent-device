import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveImportEdges } from './model.ts';
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
    'packages/daemon/src/session-state.ts': STATE_STUB,
    'packages/daemon/src/session-store.ts': STORE_STUB,
    'packages/daemon/src/handlers/fixture.ts':
      "import type { SessionState } from '../session-state.ts';\n" +
      "import { SessionStore } from '../session-store.ts';\n",
    'packages/daemon/src/handlers/request-only.ts':
      "import type { DaemonRequest } from '../session-state.ts';\n" +
      "import { resolveDaemonStateDir } from '../session-store.ts';\n",
    'packages/daemon/src/non-handler.ts':
      "import type { SessionState } from './session-state.ts';\n",
    'packages/daemon/src/handlers/fixture.test.ts':
      "import type { SessionState } from '../session-state.ts';\n",
  };
  assert.deepEqual(overlayOf(sources), {
    shapeFiles: ['packages/daemon/src/handlers/fixture.ts', 'packages/daemon/src/non-handler.ts'],
    authorityFiles: ['packages/daemon/src/handlers/fixture.ts'],
  });
});

test('the overlay follows the SessionState declaration to a moved path, not a recorded one', () => {
  // Planted-red against a hardcoded src/daemon/types.ts target: #2346 moved the declaration to
  // session-state.ts, so importers point there, and the overlay must still count them.
  const sources = {
    'packages/daemon/src/types.ts': 'export type DaemonRequest = { x: number; };\n',
    'packages/daemon/src/session-state.ts': STATE_STUB,
    'packages/daemon/src/session-store.ts': STORE_STUB,
    'packages/daemon/src/handlers/fixture.ts':
      "import type { SessionState } from '../session-state.ts';\n",
    'packages/daemon/src/non-handler.ts':
      "import type { SessionState } from './session-state.ts';\n",
  };
  assert.deepEqual(overlayOf(sources), {
    shapeFiles: ['packages/daemon/src/handlers/fixture.ts', 'packages/daemon/src/non-handler.ts'],
    authorityFiles: [],
  });
});

test('the handler-owned subset is the flat handlers surface only', () => {
  const overlay: SessionAuthorityOverlay = {
    shapeFiles: [
      'packages/daemon/src/handlers/fixture.ts',
      'packages/daemon/src/non-handler.ts',
      'packages/daemon/src/interaction/internal/interaction.ts',
    ],
    authorityFiles: [
      'packages/daemon/src/handlers/fixture.ts',
      'packages/daemon/src/request-router.ts',
    ],
  };
  assert.deepEqual(handlerOwnedOverlay(overlay), {
    shapeFiles: ['packages/daemon/src/handlers/fixture.ts'],
    authorityFiles: ['packages/daemon/src/handlers/fixture.ts'],
  });
});

test('R75 fails a handler file that gains a shape or authority edge beyond the merge-base', () => {
  const reference: SessionAuthorityOverlay = {
    shapeFiles: ['packages/daemon/src/handlers/kept.ts'],
    authorityFiles: ['packages/daemon/src/handlers/kept.ts'],
  };
  const measured: SessionAuthorityOverlay = {
    shapeFiles: [
      'packages/daemon/src/handlers/kept.ts',
      'packages/daemon/src/handlers/new-shape.ts',
    ],
    authorityFiles: ['packages/daemon/src/handlers/new-authority.ts'],
  };
  const violations = checkSessionAuthorityOverlay(measured, reference);
  assert.equal(violations.length, 2);
  const shape = violations.find(
    (violation) => violation.file === 'packages/daemon/src/handlers/new-shape.ts',
  )!;
  const authority = violations.find(
    (violation) => violation.file === 'packages/daemon/src/handlers/new-authority.ts',
  )!;
  assert.equal(shape.rule, SESSION_AUTHORITY_OVERLAY_RULE);
  assert.equal(authority.rule, SESSION_AUTHORITY_OVERLAY_RULE);
  assert.match(shape.message, /new handler-owned SessionState shape edge/);
  assert.match(authority.message, /new handler-owned SessionStore authority edge/);
});

test('R75 passes when the handler-owned sets hold or shrink', () => {
  const reference: SessionAuthorityOverlay = {
    shapeFiles: ['packages/daemon/src/handlers/a.ts', 'packages/daemon/src/handlers/b.ts'],
    authorityFiles: ['packages/daemon/src/handlers/a.ts'],
  };
  const measured: SessionAuthorityOverlay = {
    shapeFiles: ['packages/daemon/src/handlers/a.ts'],
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
    'packages/daemon/src/session-state.ts': STATE_STUB,
    'packages/daemon/src/session-store.ts': STORE_STUB,
    'packages/daemon/src/handlers/kept.ts':
      "import type { SessionState } from '../session-state.ts';\n",
  };
  const reference = handlerOwnedOverlay(overlayOf(base));
  const grown = {
    ...base,
    'packages/daemon/src/handlers/new.ts':
      "import type { SessionState } from '../session-state.ts';\n",
  };
  const measured = handlerOwnedOverlay(overlayOf(grown));
  assert.deepEqual(checkSessionAuthorityOverlay(reference, reference), []);
  const violations = checkSessionAuthorityOverlay(measured, reference);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.file, 'packages/daemon/src/handlers/new.ts');
});

test('R75 catches a new handler shape edge expressed as an import type', () => {
  const base = {
    'packages/daemon/src/session-state.ts': STATE_STUB,
    'packages/daemon/src/session-store.ts': STORE_STUB,
  };
  const reference = handlerOwnedOverlay(overlayOf(base));
  const measured = handlerOwnedOverlay(
    overlayOf({
      ...base,
      'packages/daemon/src/handlers/new.ts':
        "type State = import('../session-state.ts').SessionState;\n",
    }),
  );

  const violations = checkSessionAuthorityOverlay(measured, reference);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, SESSION_AUTHORITY_OVERLAY_RULE);
  assert.equal(violations[0]!.file, 'packages/daemon/src/handlers/new.ts');
  assert.match(violations[0]!.message, /new handler-owned SessionState shape edge/);
});
