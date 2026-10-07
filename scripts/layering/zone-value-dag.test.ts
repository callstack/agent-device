import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectBackEdges, findValueImportCycles, resolveImportEdges } from './model.ts';
import { checkZoneValueDag, zoneValueCycles } from './zone-value-dag.ts';

test('two same-rank zones importing each other form a cycle no file-level or rank check sees', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/daemon/lease.ts', "import { isTempPath } from '../remote/temp-path.ts';"],
      ['src/daemon/capture.ts', "import { isTempPath } from '../remote/temp-path.ts';"],
      ['src/remote/temp-path.ts', 'export const isTempPath = true;'],
      ['src/remote/diagnostics.ts', "import { logPath } from '../daemon/paths.ts';"],
      ['src/daemon/paths.ts', 'export const logPath = 1;'],
    ]),
  );

  assert.deepEqual(findValueImportCycles(edges), []);
  assert.deepEqual(collectBackEdges(edges), {});
  assert.deepEqual(checkZoneValueDag(edges), [
    {
      rule: 'R80 zone-value-dag',
      file: 'src/daemon/capture.ts',
      line: 1,
      message:
        'zone-level value-import cycle: daemon-server -> remote -> daemon-server ' +
        '(daemon-server -> remote: src/daemon/capture.ts -> src/remote/temp-path.ts; ' +
        'remote -> daemon-server: src/remote/diagnostics.ts -> src/daemon/paths.ts). ' +
        'Move the contract both zones read below both of them.',
    },
  ]);
});

test('type-only, dynamic and same-zone imports never close a zone cycle', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/remote/diagnostics.ts', "import { logPath } from '../daemon/paths.ts';"],
      ['src/daemon/paths.ts', "import type { TempPath } from '../remote/temp-path.ts';"],
      ['src/daemon/lease.ts', "void import('../remote/temp-path.ts');"],
      ['src/daemon/capture.ts', "import { logPath } from './paths.ts';"],
      ['src/remote/temp-path.ts', 'export type TempPath = string;'],
    ]),
  );

  assert.deepEqual(zoneValueCycles(edges), []);
  assert.deepEqual(checkZoneValueDag(edges), []);
});
