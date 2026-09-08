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
    'src/daemon/session-state.ts': STATE_STUB,
    'src/daemon/session-store.ts': STORE_STUB,
    'src/daemon/handlers/fixture.ts':
      "import type { SessionState } from '../session-state.ts';\n" +
      "import { SessionStore } from '../session-store.ts';\n",
    'src/daemon/handlers/request-only.ts':
      "import type { DaemonRequest } from '../session-state.ts';\n" +
      "import { resolveDaemonStateDir } from '../session-store.ts';\n",
    'src/daemon/non-handler.ts': "import type { SessionState } from './session-state.ts';\n",
    'src/daemon/handlers/fixture.test.ts':
      "import type { SessionState } from '../session-state.ts';\n",
  };
  assert.deepEqual(overlayOf(sources), {
    shapeFiles: ['src/daemon/handlers/fixture.ts', 'src/daemon/non-handler.ts'],
    authorityFiles: ['src/daemon/handlers/fixture.ts'],
  });
});

test('the overlay follows the SessionState declaration to a moved path, not a recorded one', () => {
  // Planted-red against a hardcoded src/daemon/types.ts target: #2346 moved the declaration to
  // session-state.ts, so importers point there, and the overlay must still count them.
  const sources = {
    'src/daemon/types.ts': 'export type DaemonRequest = { x: number; };\n',
    'src/daemon/session-state.ts': STATE_STUB,
    'src/daemon/session-store.ts': STORE_STUB,
    'src/daemon/handlers/fixture.ts': "import type { SessionState } from '../session-state.ts';\n",
    'src/daemon/non-handler.ts': "import type { SessionState } from './session-state.ts';\n",
  };
  assert.deepEqual(overlayOf(sources), {
    shapeFiles: ['src/daemon/handlers/fixture.ts', 'src/daemon/non-handler.ts'],
    authorityFiles: [],
  });
});

test('the handler-owned subset is the flat handlers surface only', () => {
  const overlay: SessionAuthorityOverlay = {
    shapeFiles: [
      'src/daemon/handlers/fixture.ts',
      'src/daemon/non-handler.ts',
      'src/daemon/interaction/internal/interaction.ts',
    ],
    authorityFiles: ['src/daemon/handlers/fixture.ts', 'src/daemon/request-router.ts'],
  };
  assert.deepEqual(handlerOwnedOverlay(overlay), {
    shapeFiles: ['src/daemon/handlers/fixture.ts'],
    authorityFiles: ['src/daemon/handlers/fixture.ts'],
  });
});

test('R75 fails a handler file that gains a shape or authority edge beyond the merge-base', () => {
  const reference: SessionAuthorityOverlay = {
    shapeFiles: ['src/daemon/handlers/kept.ts'],
    authorityFiles: ['src/daemon/handlers/kept.ts'],
  };
  const measured: SessionAuthorityOverlay = {
    shapeFiles: ['src/daemon/handlers/kept.ts', 'src/daemon/handlers/new-shape.ts'],
    authorityFiles: ['src/daemon/handlers/new-authority.ts'],
  };
  const violations = checkSessionAuthorityOverlay(measured, reference);
  assert.equal(violations.length, 2);
  const shape = violations.find(
    (violation) => violation.file === 'src/daemon/handlers/new-shape.ts',
  )!;
  const authority = violations.find(
    (violation) => violation.file === 'src/daemon/handlers/new-authority.ts',
  )!;
  assert.equal(shape.rule, SESSION_AUTHORITY_OVERLAY_RULE);
  assert.equal(authority.rule, SESSION_AUTHORITY_OVERLAY_RULE);
  assert.match(shape.message, /new handler-owned SessionState shape edge/);
  assert.match(authority.message, /new handler-owned SessionStore authority edge/);
});

test('R75 passes when the handler-owned sets hold or shrink', () => {
  const reference: SessionAuthorityOverlay = {
    shapeFiles: ['src/daemon/handlers/a.ts', 'src/daemon/handlers/b.ts'],
    authorityFiles: ['src/daemon/handlers/a.ts'],
  };
  const measured: SessionAuthorityOverlay = {
    shapeFiles: ['src/daemon/handlers/a.ts'],
    authorityFiles: [],
  };
  assert.deepEqual(checkSessionAuthorityOverlay(measured, reference), []);
});

test('R75 leaves new non-handler importers to the module declarations, not this ratchet', () => {
  const measured: SessionAuthorityOverlay = {
    shapeFiles: ['src/daemon/new-module.ts'],
    authorityFiles: ['src/daemon/server/new-module.ts'],
  };
  assert.deepEqual(
    checkSessionAuthorityOverlay(measured, { shapeFiles: [], authorityFiles: [] }),
    [],
  );
});

test('the end-to-end measurement feeds the ratchet: a new handler importer is red, an existing one is not', () => {
  const base = {
    'src/daemon/session-state.ts': STATE_STUB,
    'src/daemon/session-store.ts': STORE_STUB,
    'src/daemon/handlers/kept.ts': "import type { SessionState } from '../session-state.ts';\n",
  };
  const reference = handlerOwnedOverlay(overlayOf(base));
  const grown = {
    ...base,
    'src/daemon/handlers/new.ts': "import type { SessionState } from '../session-state.ts';\n",
  };
  const measured = handlerOwnedOverlay(overlayOf(grown));
  assert.deepEqual(checkSessionAuthorityOverlay(reference, reference), []);
  const violations = checkSessionAuthorityOverlay(measured, reference);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.file, 'src/daemon/handlers/new.ts');
});
