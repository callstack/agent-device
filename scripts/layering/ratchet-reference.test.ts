import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { memoizedImportParser, resolveImportEdges } from './model.ts';
import { measureRatchets, mergeBaseRatchets } from './ratchet-reference.ts';
import { sessionStateWritePressure } from './session-state.ts';
import { listTrackedProductionSources } from './tracked-sources.ts';
import { readCommittedSources } from '../__tests__/committed-source-tree.ts';

const SESSION_TYPES = [
  'export type SessionState = {',
  '  snapshot?: string;',
  '  trace?: string;',
  '  name: string;',
  '};',
].join('\n');

function tree(extra: Record<string, string> = {}) {
  return new Map<string, string>([
    ['src/daemon/session-state.ts', SESSION_TYPES],
    ['src/daemon/session-snapshot.ts', 'session.snapshot = "a"; nextSession.snapshot = "b";'],
    ['src/daemon/ref-frame.ts', 'session.snapshot = undefined;'],
    ['src/daemon/handlers/trace-runtime.ts', 'session.trace ??= "t";'],
    ['src/client/client.ts', "import type { Loop } from '../commands/loop.ts';"],
    ['src/commands/loop.ts', "import type { Client } from '../client/client.ts';"],
    ...Object.entries(extra),
  ]);
}

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

test('sessionStateWritePressure counts written fields and (field, writer) claims, not writes', () => {
  assert.deepEqual(sessionStateWritePressure(tree()), {
    writerOwnedFields: 2,
    ownerFileClaims: 3,
  });
  assert.deepEqual(
    sessionStateWritePressure(tree({ 'src/daemon/other.ts': 'session[key] = 1;' })),
    {
      writerOwnedFields: 2,
      ownerFileClaims: 3,
    },
  );
  assert.deepEqual(sessionStateWritePressure(new Map()), {
    writerOwnedFields: 0,
    ownerFileClaims: 0,
  });
});

test('measureRatchets reports all three ratchets from one tree', () => {
  const sources = tree();
  assert.deepEqual(measureRatchets(sources, resolveImportEdges(sources)), {
    typeInversions: { 'commands -> client': 1 },
    largestTypeCycle: ['src/client/client.ts', 'src/commands/loop.ts'],
    sessionState: { writerOwnedFields: 2, ownerFileClaims: 3 },
  });
});

test('memoizedImportParser parses each distinct source text once', () => {
  let parses = 0;
  const a = "import type { Client } from '../client/client.ts';";
  const sources = new Map([
    ['src/commands/a.ts', a],
    ['src/commands/b.ts', `${a.slice(0, 5)}${a.slice(5)}`],
    ['src/client/client.ts', 'export type Client = {};'],
  ]);
  const parse = memoizedImportParser();
  assert.deepEqual(resolveImportEdges(sources, undefined, parse), resolveImportEdges(sources));
  resolveImportEdges(sources, undefined, (source) => {
    parses++;
    return parse(source);
  });
  assert.equal(parses, 3);
  assert.equal(parse(a), parse(a));
});

// The reference is a committed tree read through the shared committed-tree reader, so its file
// set must be the one the working-tree scan uses. A divergence here means the git-side
// enumeration or blob read no longer matches the layering scan input.
test('the committed enumeration at HEAD is the working-tree scan input', () => {
  const { sources, manifests } = readCommittedSources(repoRoot, 'HEAD');
  assert.deepEqual([...sources.keys()], listTrackedProductionSources(repoRoot));
  assert.ok(manifests.has('packages/kernel/package.json'));
});

test('the merge-base reference names its ref and measures the real tree', () => {
  const reference = mergeBaseRatchets(repoRoot);
  assert.match(reference.ref, /^[0-9a-f]{40}$/);
  assert.ok(reference.largestTypeCycle.length >= 1);
  assert.ok(reference.sessionState.writerOwnedFields > 0);
  assert.ok(reference.sessionState.ownerFileClaims >= reference.sessionState.writerOwnedFields);
  assert.ok(Object.keys(reference.typeInversions).length > 0);
});
